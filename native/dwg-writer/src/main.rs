//! Offline Windows DWG copies with strict protocol, preflight, OS budget, and reopening checks.
mod spline_packet;
mod validation;
mod windows_job;

use acadrust::objects::{ObjectType, ProxyReferenceKind, XRecordValue, XRecordValueType};
use acadrust::tables::{Layer, TableEntry};
use acadrust::types::Handle;
use acadrust::{CadDocument, DwgReader, DwgWriter, DxfReader, DxfVersion};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Read, Write};

const FORMAT: &str = "AC1032";

struct OwnedOutput {
    accepted: bool,
}
impl Drop for OwnedOutput {
    fn drop(&mut self) {
        if !self.accepted {
            let _ = fs::remove_file("output.dwg");
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    schema_version: u32,
    success: bool,
    output_format: &'static str,
    output_sha256: String,
    warnings: Vec<String>,
    errors: Vec<String>,
    process_memory_limit_bytes: u64,
    input_entity_count: usize,
    output_entity_count: usize,
}

fn failure(message: &str) -> Report {
    Report {
        schema_version: 1,
        success: false,
        output_format: FORMAT,
        output_sha256: String::new(),
        warnings: vec![],
        errors: vec![message.chars().take(2000).collect()],
        process_memory_limit_bytes: 1024 * 1024 * 1024,
        input_entity_count: 0,
        output_entity_count: 0,
    }
}

fn read_bounded(name: &str) -> Result<Vec<u8>, String> {
    let stat = fs::symlink_metadata(name)
        .map_err(|_| "Cannot read the private drawing input.".to_owned())?;
    if !stat.is_file() || stat.file_type().is_symlink() || stat.len() > validation::MAX_BYTES as u64
    {
        return Err("Drawing file is not regular or exceeds 128 MiB.".into());
    }
    let mut bytes = Vec::with_capacity(stat.len() as usize);
    File::open(name)
        .map_err(|_| "Cannot open the private drawing input.".to_owned())?
        .take(validation::MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read the private drawing input.".to_owned())?;
    if bytes.len() > validation::MAX_BYTES || bytes.len() as u64 != stat.len() {
        return Err("Drawing file changed or exceeds 128 MiB.".into());
    }
    Ok(bytes)
}

fn informational_dwg_notice(message: &str) -> bool {
    if message == "Reading DWG file version: AC1032 (AC24)" {
        return true;
    }
    if let Some(rest) = message.strip_prefix("AC18 inner header: page_map_address=0x") {
        if let Some((address, id)) = rest.split_once(", section_map_id=") {
            return !address.is_empty()
                && address.chars().all(|c| c.is_ascii_hexdigit())
                && id.parse::<u32>().is_ok();
        }
    }
    for suffix in [
        " page records from page map",
        " section descriptors from section map",
    ] {
        if let Some(number) = message
            .strip_prefix("AC18: Read ")
            .and_then(|s| s.strip_suffix(suffix))
        {
            return number.parse::<u32>().is_ok();
        }
    }
    false
}

fn no_notifications(doc: &CadDocument, phase: &str) -> Result<(), String> {
    // The library labels these exact format-progress messages Warning. They contain no repair
    // or content-loss claim; every other diagnostic remains a refused export.
    let unexpected = doc.notifications.iter().find(|item| {
        !(phase == "reopening"
            && item.notification_type == acadrust::notification::NotificationType::Warning
            && informational_dwg_notice(&item.message))
    });
    if unexpected.is_some() || doc.notifications.omitted_count() != 0 {
        let detail = unexpected
            .map(|item| item.to_string())
            .unwrap_or_else(|| "unretained diagnostics".into());
        return Err(format!(
            "DWG {phase} could not preserve all drawing content: {}",
            detail.chars().take(500).collect::<String>()
        ));
    }
    Ok(())
}

fn counts(doc: &CadDocument) -> BTreeMap<String, usize> {
    let mut result = BTreeMap::new();
    for entity in doc.entities() {
        let native_kind = entity.as_entity().entity_type();
        let kind = if native_kind.starts_with("DIMENSION_") {
            "DIMENSION"
        } else if native_kind == "MINSERT" {
            "INSERT"
        } else {
            native_kind
        };
        if !matches!(kind, "BLOCK" | "ENDBLK" | "ATTRIB" | "SEQEND") {
            *result.entry(kind.to_owned()).or_default() += 1;
        }
    }
    result
}

/// Remove storage references which the DWG writer legitimately regenerates. Geometry, values,
/// attributes, layers, colors, transparency, text alignment, widths, arrays and plotting remain.
fn normalize(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            fields.retain(|key, _| {
                !matches!(
                    key.as_str(),
                    "handle"
                        | "owner"
                        | "reactors"
                        | "layout"
                        | "block_record"
                        | "viewport"
                        | "viewports"
                        | "base_ucs"
                        | "named_ucs"
                        | "entity_handles"
                        | "insert_handles"
                        | "insert_count_bytes"
                        | "dwg_minsert"
                        | "dwg_x_direction"
                        | "dwg_flags_byte"
                        | "dxf_status"
                ) && !key.ends_with("_handle")
            });
            // Dimension subclasses retain their own definition_point geometry. The base
            // duplicate is format-dependent (radius DWG uses the chord point there).
            if fields.contains_key("definition_point") {
                if let Some(Value::Object(base)) = fields.get_mut("base") {
                    base.remove("definition_point");
                }
            }
            if fields.contains_key("background_fill_flags") {
                let flags = fields["background_fill_flags"].as_i64().unwrap_or(0);
                if flags & 1 == 0 {
                    for key in [
                        "background_scale",
                        "background_color",
                        "background_transparency",
                    ] {
                        fields.remove(key);
                    }
                }
                if flags & 2 != 0 {
                    fields.remove("background_color");
                }
                // Text layout extents are derived by the CAD engine, not input geometry.
                fields.remove("extents_width");
                fields.remove("extents_height");
            }
            if fields.get("horizontal_alignment") == Some(&Value::String("Left".into()))
                && fields.get("vertical_alignment") == Some(&Value::String("Baseline".into()))
            {
                fields.remove("alignment_point");
            }
            if let Some(Value::String(name)) = fields.get_mut("linetype") {
                if name.is_empty() || name.eq_ignore_ascii_case("bylayer") {
                    *name = "ByLayer".into();
                }
            }
            for child in fields.values_mut() {
                normalize(child);
            }
        }
        Value::Array(values) => {
            for child in values {
                normalize(child);
            }
        }
        _ => {}
    }
}

fn equivalent(before: &Value, after: &Value, location: &str) -> Result<(), String> {
    match (before, after) {
        (Value::Number(a), Value::Number(b)) => {
            // Integer payloads (especially XRECORD int64) must never pass through f64.
            // Adjacent values beyond 2^53 otherwise become indistinguishable.
            if (a.is_i64() || a.is_u64()) && (b.is_i64() || b.is_u64()) {
                if a != b {
                    return Err(format!("DWG reopening changed {location}."));
                }
                return Ok(());
            }
            let a = a.as_f64().ok_or("Invalid source geometry number.")?;
            let b = b.as_f64().ok_or("Invalid reopened geometry number.")?;
            if !a.is_finite()
                || !b.is_finite()
                || (a - b).abs() > 1e-9 + a.abs().max(b.abs()) * 1e-10
            {
                return Err(format!("DWG reopening changed {location}."));
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                return Err(format!("DWG reopening changed {location} count."));
            }
            for (index, (a, b)) in a.iter().zip(b).enumerate() {
                equivalent(a, b, &format!("{location}[{index}]"))?;
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            if a.len() != b.len() {
                return Err(format!("DWG reopening changed {location} fields."));
            }
            for (key, a) in a {
                equivalent(
                    a,
                    b.get(key)
                        .ok_or_else(|| format!("DWG reopening dropped {location}.{key}."))?,
                    &format!("{location}.{key}"),
                )?;
            }
        }
        _ if before == after => {}
        _ => return Err(format!("DWG reopening changed {location}.")),
    }
    Ok(())
}

fn compare<T: Serialize>(before: &T, after: &T, location: &str) -> Result<(), String> {
    let mut before = serde_json::to_value(before)
        .map_err(|_| "Cannot verify source drawing fields.".to_owned())?;
    let mut after = serde_json::to_value(after)
        .map_err(|_| "Cannot verify reopened drawing fields.".to_owned())?;
    normalize(&mut before);
    normalize(&mut after);
    equivalent(&before, &after, location)
}

fn anonymous_names(doc: &CadDocument) -> BTreeMap<String, String> {
    doc.block_records
        .iter()
        .filter(|block| {
            block.name.starts_with('*') && !block.is_model_space() && !block.is_paper_space()
        })
        .map(|block| {
            (
                block.name.clone(),
                format!("@anonymous-block:{}", block.handle.value()),
            )
        })
        .collect()
}

fn canonicalize_names(value: &mut Value, aliases: &BTreeMap<String, String>) {
    match value {
        Value::Object(fields) => {
            if let Some(Value::String(name)) = fields.get_mut("block_name") {
                if let Some(alias) = aliases.get(name) {
                    *name = alias.clone();
                }
            }
            for child in fields.values_mut() {
                canonicalize_names(child, aliases);
            }
        }
        Value::Array(values) => {
            for child in values {
                canonicalize_names(child, aliases);
            }
        }
        _ => {}
    }
}

/// Only these metadata classes have a complete typed DXF-to-DWG representation
/// in the bounded interchange contract. Unknown records are never certified by
/// stripping their raw fields or treating their handles as harmless storage.
fn retained_metadata(object: &ObjectType) -> bool {
    matches!(
        object,
        ObjectType::Dictionary(_)
            | ObjectType::DictionaryWithDefault(_)
            | ObjectType::Field(_)
            | ObjectType::FieldList(_)
            | ObjectType::XRecord(_)
    )
}

fn add_alias(
    aliases: &mut BTreeMap<u64, String>,
    handle: Handle,
    identity: String,
) -> Result<(), String> {
    if handle.is_null() {
        return Ok(());
    }
    if let Some(previous) = aliases.get(&handle.value()) {
        if previous != &identity {
            return Err("Drawing metadata contains conflicting native identities.".into());
        }
    } else {
        aliases.insert(handle.value(), identity);
    }
    Ok(())
}

/// Symbol names/control roles are stable when storage handles are regenerated.
/// Entities retain the identities already required by the geometry guard;
/// objects reachable through dictionary keys/field-child indexes use those paths.
fn metadata_aliases(doc: &CadDocument) -> Result<BTreeMap<u64, String>, String> {
    let mut aliases = BTreeMap::new();
    let anonymous = anonymous_names(doc);
    macro_rules! table {
        ($name:ident) => {
            add_alias(
                &mut aliases,
                doc.$name.handle(),
                concat!("table:", stringify!($name)).into(),
            )?;
            for entry in doc.$name.iter() {
                let name = if stringify!($name) == "block_records" {
                    anonymous
                        .get(entry.name())
                        .cloned()
                        .unwrap_or_else(|| entry.name().to_owned())
                } else {
                    entry.name().to_owned()
                };
                add_alias(
                    &mut aliases,
                    entry.handle(),
                    format!("{}:{name:?}", stringify!($name)),
                )?;
            }
        };
    }
    table!(layers);
    table!(line_types);
    table!(text_styles);
    table!(block_records);
    table!(dim_styles);
    table!(app_ids);
    table!(views);
    table!(vports);
    table!(ucss);
    table!(vx_table);
    for entity in doc.entities() {
        add_alias(
            &mut aliases,
            entity.common().handle,
            format!("entity:{:X}", entity.common().handle.value()),
        )?;
    }
    add_alias(
        &mut aliases,
        doc.header.named_objects_dict_handle,
        "named-objects".into(),
    )?;
    let mut queue = aliases
        .iter()
        .map(|(handle, identity)| (identity.clone(), *handle))
        .collect::<BTreeSet<_>>();
    let mut visited = BTreeSet::new();
    while let Some((identity, handle)) = queue.pop_first() {
        if !visited.insert(handle) {
            continue;
        }
        let native_handle = Handle::new(handle);
        let mut children = Vec::new();
        if let Some(extension) = doc.extension_dictionary_handle(native_handle) {
            children.push((extension, format!("{identity}/extension")));
        }
        match doc.objects.get(&native_handle) {
            Some(ObjectType::Dictionary(value)) => {
                for (key, target) in &value.entries {
                    children.push((*target, format!("{identity}/key:{key:?}")));
                }
            }
            Some(ObjectType::DictionaryWithDefault(value)) => {
                for (key, target) in &value.entries {
                    children.push((*target, format!("{identity}/key:{key:?}")));
                }
            }
            Some(ObjectType::Field(value)) => {
                for (index, target) in value.child_fields.iter().enumerate() {
                    children.push((*target, format!("{identity}/child:{index}")));
                }
            }
            _ => {}
        }
        for (target, path) in children {
            // A shared pointer does not create a new object identity. Its edge is
            // still compared below; the first reachable stable path is canonical.
            if target.is_null() || aliases.contains_key(&target.value()) {
                continue;
            }
            if !doc.objects.contains_key(&target) {
                return Err("Drawing metadata contains a missing owned object.".into());
            }
            aliases.insert(target.value(), path.clone());
            queue.insert((path, target.value()));
        }
    }
    for handle in doc.objects.keys() {
        aliases
            .entry(handle.value())
            .or_insert_with(|| format!("object:{:X}", handle.value()));
    }
    Ok(aliases)
}

fn canonical_handle(value: &mut Value, aliases: &BTreeMap<u64, String>) -> Result<(), String> {
    if value.is_null() {
        return Ok(());
    }
    let handle = value.as_u64().ok_or("Invalid typed metadata handle.")?;
    *value = if handle == 0 {
        Value::Null
    } else {
        Value::String(
            aliases
                .get(&handle)
                .ok_or("Drawing metadata contains an unresolved reference.")?
                .clone(),
        )
    };
    Ok(())
}

/// Handle-bearing fields are explicit. Literal strings, binary bytes and numeric
/// values are not searched or rewritten as possible handles.
fn canonicalize_metadata(value: &mut Value, aliases: &BTreeMap<u64, String>) -> Result<(), String> {
    match value {
        Value::Object(fields) => {
            for (key, child) in fields {
                if matches!(key.as_str(), "handle" | "owner" | "Handle" | "handle_value")
                    || key.ends_with("_handle")
                {
                    canonical_handle(child, aliases)?;
                } else if matches!(
                    key.as_str(),
                    "reactors" | "child_fields" | "referenced_objects" | "fields"
                ) {
                    for handle in child
                        .as_array_mut()
                        .ok_or("Invalid typed metadata reference list.")?
                    {
                        canonical_handle(handle, aliases)?;
                    }
                } else if key == "entries"
                    && child.as_array().is_some_and(|entries| {
                        entries.first().is_some_and(|entry| entry.is_array())
                    })
                {
                    for entry in child.as_array_mut().unwrap() {
                        let pair = entry.as_array_mut().ok_or("Invalid dictionary entry.")?;
                        if pair.len() != 2 || !pair[0].is_string() {
                            return Err("Invalid dictionary entry.".into());
                        }
                        canonical_handle(&mut pair[1], aliases)?;
                    }
                } else {
                    canonicalize_metadata(child, aliases)?;
                }
            }
        }
        Value::Array(values) => {
            for child in values {
                canonicalize_metadata(child, aliases)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn checked_xrecord(object: &acadrust::objects::XRecord) -> Result<(), String> {
    if !object.entries_complete {
        return Err("XRECORD has an incomplete typed payload. Save a DXF copy instead.".into());
    }
    let mut references = Vec::new();
    for entry in &object.entries {
        let coherent = matches!(
            (entry.value_type(), &entry.value),
            (XRecordValueType::String, XRecordValue::String(_))
                | (XRecordValueType::Point3D, XRecordValue::Point3D(_, _, _))
                | (XRecordValueType::Double, XRecordValue::Double(_))
                | (XRecordValueType::Byte, XRecordValue::Byte(_))
                | (XRecordValueType::Int16, XRecordValue::Int16(_))
                | (XRecordValueType::Int32, XRecordValue::Int32(_))
                | (XRecordValueType::Int64, XRecordValue::Int64(_))
                | (
                    XRecordValueType::Handle | XRecordValueType::ObjectId,
                    XRecordValue::Handle(_)
                )
                | (XRecordValueType::Bool, XRecordValue::Bool(_))
                | (XRecordValueType::Chunk, XRecordValue::Chunk(_))
        );
        if !coherent || entry.code <= 0 || matches!(entry.code, 5 | 105) || entry.code > 1071 {
            return Err(
                "XRECORD has an unsupported group-code/value schema. Save a DXF copy instead."
                    .into(),
            );
        }
        if (330..=369).contains(&entry.code) {
            let XRecordValue::Handle(handle) = &entry.value else {
                unreachable!()
            };
            let kind = match entry.code {
                330..=339 => ProxyReferenceKind::SoftPointer,
                340..=349 => ProxyReferenceKind::HardPointer,
                350..=359 => ProxyReferenceKind::SoftOwnership,
                _ => ProxyReferenceKind::HardOwnership,
            };
            references.push((*handle, kind));
        }
    }
    if references.len() != object.object_references.len()
        || references
            .iter()
            .zip(&object.object_references)
            .any(|((handle, kind), reference)| {
                *handle != reference.handle || *kind != reference.kind
            })
    {
        return Err(
            "XRECORD has an incoherent ordered reference stream. Save a DXF copy instead.".into(),
        );
    }
    Ok(())
}

fn typed_metadata_value(object: &ObjectType) -> Result<Value, String> {
    if let ObjectType::XRecord(value) = object {
        checked_xrecord(value)?;
    }
    let mut value =
        serde_json::to_value(object).map_err(|_| "Cannot verify typed metadata fields.")?;
    if let Some(fields) = value.get_mut("XRecord").and_then(Value::as_object_mut) {
        // These fields describe binary storage, not decoded XRECORD values or
        // reference kinds. Completeness and all typed entries remain mandatory.
        for key in [
            "raw_data",
            "raw_dwg_handle_bits",
            "preserve_object_reference_stream",
        ] {
            fields.remove(key);
        }
    }
    Ok(value)
}

fn checked_metadata_object(doc: &CadDocument, object: &ObjectType) -> Result<(), String> {
    let entries = match object {
        ObjectType::Dictionary(value) => Some(&value.entries),
        ObjectType::DictionaryWithDefault(value) => Some(&value.entries),
        ObjectType::Field(value) => {
            for child in &value.child_fields {
                if !matches!(doc.objects.get(child), Some(ObjectType::Field(_)))
                    || doc.object_owner(*child) != Some(value.handle)
                {
                    return Err(
                        "FIELD child has a missing identity, wrong class or changed ownership."
                            .into(),
                    );
                }
            }
            None
        }
        ObjectType::FieldList(value) => {
            if value
                .fields
                .iter()
                .any(|handle| !matches!(doc.objects.get(handle), Some(ObjectType::Field(_))))
            {
                return Err("FIELDLIST references a missing or non-FIELD object.".into());
            }
            None
        }
        _ => None,
    };
    if let Some(entries) = entries {
        let mut keys = BTreeSet::new();
        if entries
            .iter()
            .any(|(key, _)| key.is_empty() || !keys.insert(key.to_uppercase()))
        {
            return Err("Dictionary metadata contains empty or duplicate keys.".into());
        }
    }
    Ok(())
}

fn metadata_snapshot(doc: &CadDocument) -> Result<Value, String> {
    let aliases = metadata_aliases(doc)?;
    let mut graph = BTreeMap::new();
    for (handle, object) in &doc.objects {
        if matches!(object, ObjectType::Unknown { .. }) {
            return Err(
                "Unknown native object cannot be verified for DWG export. Save a DXF copy instead."
                    .into(),
            );
        }
        if !retained_metadata(object) {
            continue;
        }
        checked_metadata_object(doc, object)?;
        let mut value = typed_metadata_value(object)?;
        canonicalize_metadata(&mut value, &aliases)?;
        if graph
            .insert(aliases[&handle.value()].clone(), value)
            .is_some()
        {
            return Err("Drawing metadata contains duplicate canonical identities.".into());
        }
    }
    let mut views = BTreeMap::new();
    for view in doc.views.iter() {
        let mut value =
            serde_json::to_value(view).map_err(|_| "Cannot verify named VIEW fields.")?;
        canonicalize_metadata(&mut value, &aliases)?;
        views.insert(view.name.clone(), value);
    }
    let mut common = BTreeMap::new();
    for (handle, identity) in &aliases {
        let handle = Handle::new(*handle);
        let reactors = doc.object_reactors(handle);
        let extension = doc.extension_dictionary_handle(handle);
        if !reactors.is_empty() || extension.is_some() {
            let mut value =
                serde_json::json!({ "reactors": reactors, "xdictionary_handle": extension });
            canonicalize_metadata(&mut value, &aliases)?;
            common.insert(identity.clone(), value);
        }
    }
    let mut xdata = BTreeMap::new();
    for entity in doc.entities() {
        let records = &entity.common().extended_data;
        if records.records().is_empty() {
            continue;
        }
        let mut value = serde_json::to_value(records).map_err(|_| "Cannot verify entity XDATA.")?;
        canonicalize_metadata(&mut value, &aliases)?;
        xdata.insert(aliases[&entity.common().handle.value()].clone(), value);
    }
    for (handle, records) in &doc.object_xdata {
        if records.records().is_empty() {
            continue;
        }
        let mut value =
            serde_json::to_value(records).map_err(|_| "Cannot verify metadata XDATA.")?;
        canonicalize_metadata(&mut value, &aliases)?;
        let identity = aliases
            .get(&handle.value())
            .ok_or("XDATA source identity is unresolved.")?
            .clone();
        if let Some(entity_value) = xdata.get(&identity) {
            equivalent(entity_value, &value, "duplicate XDATA source")?;
        }
        xdata.insert(identity, value);
    }
    Ok(serde_json::json!({ "views": views, "objects": graph, "common": common, "xdata": xdata }))
}

#[derive(Default, Debug)]
struct SourceLiterals {
    xrecords: BTreeMap<u64, Vec<(i32, String)>>,
    xdata: BTreeMap<u64, Vec<String>>,
}

#[derive(Default)]
struct LiteralRecord {
    kind: String,
    handle: Option<u64>,
    subclass: bool,
    payload: bool,
    application: bool,
    xrecord: Vec<(i32, String)>,
    xdata: Vec<String>,
}

impl LiteralRecord {
    fn finish(self, source: &mut SourceLiterals) -> Result<(), String> {
        if self.kind != "XRECORD" && self.xdata.is_empty() {
            return Ok(());
        }
        let handle = self
            .handle
            .filter(|handle| *handle != 0)
            .ok_or("Opaque DXF metadata has no source identity. Save a DXF copy instead.")?;
        if self.kind == "XRECORD" {
            if !self.subclass || !self.payload {
                return Err("XRECORD source schema is incomplete. Save a DXF copy instead.".into());
            }
            if source.xrecords.insert(handle, self.xrecord).is_some() {
                return Err("Opaque DXF metadata repeats a source identity.".into());
            }
        }
        if !self.xdata.is_empty() && source.xdata.insert(handle, self.xdata).is_some() {
            return Err("Opaque DXF XDATA repeats a source identity.".into());
        }
        Ok(())
    }
}

/// Capture literal payloads independently of the third-party DXF decoder. Input has
/// already passed the bounded ASCII preflight; strings are never display-unescaped.
fn source_literals(text: &str) -> Result<SourceLiterals, String> {
    let mut result = SourceLiterals::default();
    let mut record = LiteralRecord::default();
    let mut lines = text.lines();
    while let Some(code) = lines.next() {
        let value = lines.next().ok_or("Incomplete source literal pair.")?;
        let code = code
            .trim()
            .parse::<i32>()
            .map_err(|_| "Invalid source literal code.")?;
        if code == 0 {
            record.finish(&mut result)?;
            record = LiteralRecord {
                kind: value.trim().to_uppercase(),
                ..LiteralRecord::default()
            };
            continue;
        }
        if code == 105 && record.kind == "DIMSTYLE" || code == 5 && record.kind != "DIMSTYLE" {
            record.handle = u64::from_str_radix(value.trim(), 16).ok();
        }
        if code == 1001 {
            record.application = true;
            continue;
        }
        if record.application {
            if code == 1000 {
                record.xdata.push(value.to_owned());
            }
            continue;
        }
        if record.kind != "XRECORD" {
            continue;
        }
        if !record.payload {
            if code == 100 && value.trim() == "AcDbXrecord" {
                record.subclass = true;
            }
            if code == 280 {
                record.payload = true;
            }
            continue;
        }
        if matches!(XRecordValueType::from_code(code), XRecordValueType::String) {
            record.xrecord.push((code, value.to_owned()));
        }
    }
    record.finish(&mut result)?;
    Ok(result)
}

fn verify_source_literals(doc: &CadDocument, source: &SourceLiterals) -> Result<(), String> {
    for (handle, expected) in &source.xrecords {
        let Some(ObjectType::XRecord(object)) = doc.objects.get(&Handle::new(*handle)) else {
            return Err(
                "XRECORD literal source identity was lost. Save a DXF copy instead.".into(),
            );
        };
        let actual = object
            .entries
            .iter()
            .filter_map(|entry| match &entry.value {
                XRecordValue::String(value) => Some((entry.code, value.clone())),
                _ => None,
            })
            .collect::<Vec<_>>();
        if &actual != expected {
            return Err(
                "XRECORD literal payload changed during DXF import. Save a DXF copy instead."
                    .into(),
            );
        }
    }
    for (handle, expected) in &source.xdata {
        let handle = Handle::new(*handle);
        let entity = doc.get_entity(handle);
        let records = entity
            .map(|value| &value.common().extended_data)
            .filter(|records| !records.records().is_empty())
            .or_else(|| match doc.objects.get(&handle) {
                Some(ObjectType::Field(value)) => Some(&value.xdata),
                _ => None,
            })
            .filter(|records| !records.records().is_empty())
            .or_else(|| doc.object_xdata.get(&handle))
            .ok_or("XDATA literal source identity was lost. Save a DXF copy instead.")?;
        let actual = records
            .records()
            .iter()
            .flat_map(|record| &record.values)
            .filter_map(|value| match value {
                acadrust::xdata::XDataValue::String(value) => Some(value.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        if &actual != expected {
            return Err(
                "XDATA literal payload changed during DXF import. Save a DXF copy instead.".into(),
            );
        }
    }
    Ok(())
}

fn verify_reopening(before: &CadDocument, after: &CadDocument) -> Result<(), String> {
    if after.version != DxfVersion::AC1032
        || counts(before) != counts(after)
        || before.entities().count() != after.entities().count()
    {
        return Err("DWG reopening changed the drawing version or entity counts.".into());
    }
    equivalent(
        &metadata_snapshot(before)?,
        &metadata_snapshot(after)?,
        "metadata graph",
    )?;
    let source_names = anonymous_names(before);
    let reopened_names = anonymous_names(after);
    for entity in before.entities() {
        let reopened = after
            .get_entity(entity.common().handle)
            .ok_or("DWG reopening dropped an entity.")?;
        let mut source =
            serde_json::to_value(entity).map_err(|_| "Cannot verify source entity fields.")?;
        let mut result =
            serde_json::to_value(reopened).map_err(|_| "Cannot verify reopened entity fields.")?;
        canonicalize_names(&mut source, &source_names);
        canonicalize_names(&mut result, &reopened_names);
        normalize(&mut source);
        normalize(&mut result);
        equivalent(&source, &result, "entity")?;
    }
    if before.block_records.len() != after.block_records.len() {
        return Err("DWG reopening changed the block count.".into());
    }
    for block in before.block_records.iter() {
        let renamed = source_names.contains_key(&block.name);
        let reopened = if renamed {
            after
                .block_records
                .iter()
                .find(|candidate| candidate.handle == block.handle)
        } else {
            after.block_records.get(&block.name)
        }
        .ok_or("DWG reopening dropped a block definition.")?;
        let mut source_block = block.clone();
        let mut result_block = reopened.clone();
        if renamed {
            source_block.name = source_names[&block.name].clone();
            result_block.name = reopened_names
                .get(&reopened.name)
                .ok_or("DWG reopening changed an anonymous block identity.")?
                .clone();
        }
        compare(&source_block, &result_block, "block")?;
        let source = before
            .entities_in_block(&block.name)
            .map(|entity| entity.common().handle)
            .collect::<Vec<_>>();
        let result = after
            .entities_in_block(&reopened.name)
            .map(|entity| entity.common().handle)
            .collect::<Vec<_>>();
        if source != result {
            return Err("DWG reopening changed block entity ownership or order.".into());
        }
    }
    macro_rules! tables {
        ($table:ident) => {
            if before.$table.len() != after.$table.len() {
                return Err(concat!(
                    "DWG reopening changed the ",
                    stringify!($table),
                    " table count."
                )
                .into());
            }
            for item in before.$table.iter() {
                let reopened = after.$table.get(&item.name).ok_or(concat!(
                    "DWG reopening dropped a ",
                    stringify!($table),
                    " entry."
                ))?;
                compare(item, reopened, stringify!($table))?;
            }
        };
    }
    tables!(layers);
    tables!(line_types);
    tables!(text_styles);
    tables!(dim_styles);
    let layouts = |doc: &CadDocument| {
        doc.objects
            .values()
            .filter_map(|object| {
                if let ObjectType::Layout(layout) = object {
                    Some((layout.name.clone(), layout.clone()))
                } else {
                    None
                }
            })
            .collect::<BTreeMap<_, _>>()
    };
    let source = layouts(before);
    let result = layouts(after);
    if source.len() != result.len() {
        return Err("DWG reopening changed the layout count.".into());
    }
    for (name, layout) in source {
        compare(
            &layout,
            result.get(&name).ok_or("DWG reopening dropped a layout.")?,
            "layout",
        )?;
    }
    Ok(())
}

fn convert() -> Result<Report, String> {
    let _memory_limit = windows_job::ProcessLimit::install()?;
    // CLI accepts only these fresh private-workspace filenames; destinations are controlled by
    // the Electron main process after verification, never passed into a native CAD parser.
    if fs::symlink_metadata("output.dwg").is_ok() || fs::symlink_metadata("report.json").is_ok() {
        return Err("The private DWG output already exists.".into());
    }
    let bytes = read_bounded("input.dxf")?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| "DWG export expects UTF-8 DXF interchange input.")?;
    let preflight = validation::validate(text)?;
    let literal_source = source_literals(text)?;
    let layers = preflight
        .layers
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let expected_counts = preflight.entity_counts;
    // Parse the exact bounded bytes already validated, instead of reopening a mutable file.
    let mut document = DxfReader::from_reader(std::io::Cursor::new(bytes))
        .map_err(|error| error.to_string())?
        .read()
        .map_err(|error| error.to_string())?;
    no_notifications(&document, "import")?;
    // A parser-normalized baseline must not hide a changed literal payload.
    // This runs before any output is created; reopening compares these verified
    // typed strings exactly through the strict metadata snapshot.
    verify_source_literals(&document, &literal_source)?;
    if counts(&document) != expected_counts {
        return Err(
            "The DWG engine could not preserve every DXF entity record. Save a DXF copy instead."
                .into(),
        );
    }
    // DXF attributes can name an undeclared layer. Materialize those references before the DWG
    // engine allocates table handles, so attribute layers survive the conversion.
    for name in layers {
        if document.layers.get(&name).is_none() {
            document
                .layers
                .add(Layer::new(name))
                .map_err(|error| error.to_string())?;
        }
    }
    spline_packet::prepare(&mut document)?;
    document.version = DxfVersion::AC1032;
    // Refuse incomplete/unsupported native graph values before creating any output.
    metadata_snapshot(&document)?;
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open("output.dwg")
        .map_err(|_| "Cannot create the private DWG output.")?;
    let mut owned_output = OwnedOutput { accepted: false };
    let written = (|| -> Result<Report, String> {
        let mut output = BufWriter::new(file);
        DwgWriter::write_to_writer(&mut output, &document).map_err(|error| error.to_string())?;
        output
            .flush()
            .map_err(|_| "Cannot finish the DWG output.")?;
        output
            .get_ref()
            .sync_all()
            .map_err(|_| "Cannot synchronize the DWG output.")?;
        drop(output);
        let result = read_bounded("output.dwg")?;
        if result.len() < 128 || &result[..6] != FORMAT.as_bytes() {
            return Err("The DWG engine produced an invalid output format.".into());
        }
        let mut reopened = DwgReader::from_file("output.dwg")
            .map_err(|error| error.to_string())?
            .read()
            .map_err(|error| error.to_string())?;
        no_notifications(&reopened, "reopening")?;
        spline_packet::verify_and_restore(&mut reopened)?;
        verify_reopening(&document, &reopened)?;
        Ok(Report {
            schema_version: 1,
            success: true,
            output_format: FORMAT,
            output_sha256: format!("{:x}", Sha256::digest(&result)),
            warnings: vec![],
            errors: vec![],
            process_memory_limit_bytes: 1024 * 1024 * 1024,
            input_entity_count: document.entities().count(),
            output_entity_count: reopened.entities().count(),
        })
    })();
    if written.is_ok() {
        owned_output.accepted = true;
    }
    written
}

fn write_report(report: &Report) -> Result<(), String> {
    let bytes = serde_json::to_vec(report).map_err(|_| "Cannot encode the DWG result report.")?;
    if bytes.len() > 1024 * 1024 {
        return Err("DWG result report exceeds its supported size.".into());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open("report.json")
        .map_err(|_| "Cannot create the private DWG result report.")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot save the private DWG result report.".into())
}

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    if args.len() != 5 || args[1..] != ["convert", "input.dxf", "output.dwg", "report.json"] {
        eprintln!("Expected: convert input.dxf output.dwg report.json");
        std::process::exit(2);
    }
    std::panic::set_hook(Box::new(|_| {}));
    let outcome = std::panic::catch_unwind(convert).unwrap_or_else(|_| {
        Err("The DWG writer could not process this drawing safely. Save a DXF copy instead.".into())
    });
    let (report, exit_code) = match outcome {
        Ok(report) => (report, 0),
        Err(message) => {
            eprintln!("{}", message.chars().take(2000).collect::<String>());
            (failure(&message), 1)
        }
    };
    if let Err(message) = write_report(&report) {
        eprintln!("{message}");
        std::process::exit(1);
    }
    std::process::exit(exit_code);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn literal_document() -> (String, CadDocument) {
        let literal =
            r#"Δ 雷 literal \U+0041 JSON {"literal":"\\U+0041","newline":"\n","caret":"^J^M^I^ "}"#;
        let source = format!("0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1032\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLINE\n5\nA0\n100\nAcDbEntity\n8\n0\n100\nAcDbLine\n10\n0\n20\n0\n30\n0\n11\n1\n21\n1\n31\n0\n1001\nLITERAL\n1000\n{literal}\n1000\nsecond ^J \\n\n0\nTEXT\n5\nA1\n100\nAcDbEntity\n8\n0\n100\nAcDbText\n10\n0\n20\n0\n30\n0\n40\n1\n1\nDisplay \\U+0394^Jnext\n0\nENDSEC\n0\nSECTION\n2\nOBJECTS\n0\nXRECORD\n5\nB0\n330\n0\n100\nAcDbXrecord\n280\n1\n1\n{literal}\n300\nsecond ^J \\n\n0\nFIELD\n5\nC0\n330\n0\n100\nAcDbField\n1\nAcExpr\n2\n1+1\n90\n0\n97\n0\n1001\nFIELD_LITERAL\n1000\n{literal}\n0\nENDSEC\n0\nEOF\n");
        validation::validate(&source).unwrap();
        let document = DxfReader::from_reader(std::io::Cursor::new(source.as_bytes()))
            .unwrap()
            .read()
            .unwrap();
        (source, document)
    }

    #[test]
    fn source_literal_guard_preserves_raw_xrecord_xdata_and_display_decoding() {
        let (source, document) = literal_document();
        let literals = source_literals(&source).unwrap();
        verify_source_literals(&document, &literals).unwrap();
        let text = document.get_entity(Handle::new(0xA1)).unwrap();
        let acadrust::entities::EntityType::Text(text) = text else {
            panic!("TEXT missing");
        };
        assert_eq!(text.value, "Display Δ\nnext");
        assert_eq!(literals.xrecords[&0xB0][0].0, 1);
        assert_eq!(literals.xrecords[&0xB0][1], (300, r"second ^J \n".into()));
        assert_eq!(literals.xdata[&0xA0].len(), 2);
        assert_eq!(literals.xdata[&0xC0].len(), 1);
    }

    #[test]
    fn source_literal_guard_refuses_normalized_or_reordered_payloads() {
        let (source, document) = literal_document();
        let literals = source_literals(&source).unwrap();
        for (from, to) in [(r"\U+0041", "A"), (r"\n", "\n"), ("^J", "\n"), ("Δ", "D")] {
            let mut changed = document.clone();
            let Some(ObjectType::XRecord(object)) = changed.objects.get_mut(&Handle::new(0xB0))
            else {
                panic!("XRECORD missing");
            };
            let XRecordValue::String(value) = &mut object.entries[0].value else {
                panic!("literal missing");
            };
            *value = value.replace(from, to);
            assert!(verify_source_literals(&changed, &literals).is_err());
        }
        let mut changed = document.clone();
        let Some(ObjectType::XRecord(object)) = changed.objects.get_mut(&Handle::new(0xB0)) else {
            panic!("XRECORD missing");
        };
        object.entries.reverse();
        assert!(verify_source_literals(&changed, &literals).is_err());
        let entity = changed.get_entity_mut(Handle::new(0xA0)).unwrap();
        let mut record = entity.common().extended_data.records()[0].clone();
        let acadrust::xdata::XDataValue::String(value) = &mut record.values[0] else {
            panic!("XDATA missing");
        };
        *value = value.replace(r"\U+0041", "A");
        entity.common_mut().extended_data.upsert_record(record);
        // Keep the XRECORD intact so this failure proves the XDATA boundary.
        changed.objects.insert(
            Handle::new(0xB0),
            document.objects[&Handle::new(0xB0)].clone(),
        );
        assert!(verify_source_literals(&changed, &literals)
            .unwrap_err()
            .contains("XDATA literal"));
    }

    #[test]
    fn source_literal_guard_requires_xrecord_schema_identity_and_every_string() {
        let (source, document) = literal_document();
        for invalid in [
            source.replace("5\nB0\n", "5\n0\n"),
            source.replace("100\nAcDbXrecord\n", ""),
            source.replace("280\n1\n", ""),
        ] {
            assert!(source_literals(&invalid).is_err());
        }
        let literals = source_literals(&source).unwrap();
        let mut changed = document.clone();
        changed.objects.remove(&Handle::new(0xB0));
        assert!(verify_source_literals(&changed, &literals).is_err());
        let mut changed = document.clone();
        let Some(ObjectType::XRecord(object)) = changed.objects.get_mut(&Handle::new(0xB0)) else {
            panic!("XRECORD missing");
        };
        object.entries.pop();
        assert!(verify_source_literals(&changed, &literals).is_err());
    }
    #[test]
    fn report_contract_is_explicit_and_bounded() {
        let report = failure(&"x".repeat(5000));
        let json = serde_json::to_value(report).unwrap();
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["success"], false);
        assert_eq!(json["outputFormat"], FORMAT);
        assert_eq!(json["warnings"], serde_json::json!([]));
        assert_eq!(json["errors"][0].as_str().unwrap().len(), 2000);
    }
    #[test]
    fn informational_notice_allowlist_does_not_hide_repairs_or_unknown_warnings() {
        assert!(informational_dwg_notice(
            "Reading DWG file version: AC1032 (AC24)"
        ));
        assert!(informational_dwg_notice(
            "AC18 inner header: page_map_address=0x123, section_map_id=7"
        ));
        assert!(informational_dwg_notice(
            "AC18: Read 7 page records from page map"
        ));
        for message in [
            "Reading DWG file version: AC1015 (AC15)",
            "AC18: Invalid compressed size",
            "Failsafe: skipped corrupt page",
            "AC18: Read dropped section descriptors from section map",
        ] {
            assert!(!informational_dwg_notice(message));
        }
    }
    #[test]
    fn semantic_guard_rejects_geometry_color_and_attribute_changes() {
        let source = serde_json::json!({"point":[1.0,2.0],"color":7,"attributes":{"TAG1":"K1"}});
        assert!(equivalent(
            &source,
            &serde_json::json!({"point":[1.0,3.0],"color":7,"attributes":{"TAG1":"K1"}}),
            "entity"
        )
        .is_err());
        assert!(equivalent(
            &source,
            &serde_json::json!({"point":[1.0,2.0],"color":2,"attributes":{"TAG1":"K1"}}),
            "entity"
        )
        .is_err());
        assert!(equivalent(
            &source,
            &serde_json::json!({"point":[1.0,2.0],"color":7,"attributes":{"TAG1":"K2"}}),
            "entity"
        )
        .is_err());
    }

    #[test]
    fn reopening_guard_rejects_unexpected_table_entries() {
        let mut source = CadDocument::new();
        source.version = DxfVersion::AC1032;
        let mut changed = source.clone();
        changed
            .layers
            .add(Layer::new("UNEXPECTED_OUTPUT_LAYER"))
            .unwrap();
        assert!(verify_reopening(&source, &changed)
            .unwrap_err()
            .contains("layers table count"));
    }
    #[test]
    fn anonymous_renaming_preserves_block_identity_and_rejects_reference_changes() {
        let source_names = BTreeMap::from([("*D1".into(), "@anonymous-block:42".into())]);
        let result_names = BTreeMap::from([
            ("*D0".into(), "@anonymous-block:42".into()),
            ("*D1".into(), "@anonymous-block:43".into()),
        ]);
        let mut source = serde_json::json!({"block_name":"*D1","point":[1,2]});
        let mut result = serde_json::json!({"block_name":"*D0","point":[1,2]});
        canonicalize_names(&mut source, &source_names);
        canonicalize_names(&mut result, &result_names);
        assert!(equivalent(&source, &result, "entity").is_ok());
        let mut changed = serde_json::json!({"block_name":"*D1","point":[1,2]});
        canonicalize_names(&mut changed, &result_names);
        assert!(equivalent(&source, &changed, "entity").is_err());
    }
    #[test]
    fn storage_normalization_keeps_semantics_and_accepts_tiny_float_rounding() {
        let mut source = serde_json::json!({"handle":1,"owner_handle":2,"point":[1.0,2.0],"background_fill_flags":16,"background_color":7,"background_scale":1.5});
        let mut after = serde_json::json!({"handle":3,"owner_handle":4,"point":[1.0,2.00000000001],"background_fill_flags":16,"background_color":2,"background_scale":0.0});
        normalize(&mut source);
        normalize(&mut after);
        assert!(equivalent(&source, &after, "entity").is_ok());
        after["background_fill_flags"] = serde_json::json!(1);
        assert!(equivalent(&source, &after, "entity").is_err());
    }
    #[test]
    fn semantic_guard_keeps_viewport_twist_center_target_and_direction() {
        let mut source = serde_json::json!({
            "handle": 1, "viewport": 4, "viewports": [4],
            "twist_angle": std::f64::consts::FRAC_PI_2,
            "view_center": {"x": -190.0, "y": 120.0, "z": 0.0},
            "view_target": {"x": 0.0, "y": 0.0, "z": 0.0},
            "view_direction": {"x": 0.0, "y": 0.0, "z": 1.0}
        });
        normalize(&mut source);
        for (field, changed) in [
            ("twist_angle", serde_json::json!(0.0)),
            (
                "view_center",
                serde_json::json!({"x": 120.0, "y": 190.0, "z": 0.0}),
            ),
            (
                "view_target",
                serde_json::json!({"x": 1.0, "y": 0.0, "z": 0.0}),
            ),
            (
                "view_direction",
                serde_json::json!({"x": 0.0, "y": 0.0, "z": -1.0}),
            ),
        ] {
            let mut result = source.clone();
            result[field] = changed;
            normalize(&mut result);
            assert!(equivalent(&source, &result, "viewport").is_err());
        }
        assert!(equivalent(&source, &source.clone(), "viewport").is_ok());
    }
    fn metadata_document(offset: u64) -> CadDocument {
        use acadrust::objects::{Dictionary, Field, FieldList, XRecord, XRecordEntry};
        let mut doc = CadDocument::new();
        doc.version = DxfVersion::AC1032;
        let root = Handle::new(offset + 0x200);
        let parent = Handle::new(offset + 0x201);
        let first = Handle::new(offset + 0x202);
        let second = Handle::new(offset + 0x203);
        let list = Handle::new(offset + 0x204);
        let record = Handle::new(offset + 0x205);
        doc.header.named_objects_dict_handle = root;
        let mut dictionary = Dictionary::new();
        dictionary.handle = root;
        dictionary.add_entry("FIELD", parent);
        dictionary.add_entry("FIELDLIST", list);
        dictionary.add_entry("PAYLOAD", record);
        dictionary.set_entry_hard_owner("FIELD", true);
        doc.objects.insert(root, ObjectType::Dictionary(dictionary));
        doc.objects.insert(
            parent,
            ObjectType::Field(Field {
                handle: parent,
                owner: root,
                code: " %<\\_FldIdx 0>% + %<\\_FldIdx 1>% Δ ".into(),
                evaluator_id: "_text".into(),
                child_fields: vec![first, second],
                referenced_objects: vec![record],
                ..Field::default()
            }),
        );
        for (handle, code) in [(first, "FIRST"), (second, "SECOND")] {
            doc.objects.insert(
                handle,
                ObjectType::Field(Field {
                    handle,
                    owner: parent,
                    code: code.into(),
                    evaluator_id: "AcExpr".into(),
                    ..Field::default()
                }),
            );
        }
        doc.objects.insert(
            list,
            ObjectType::FieldList(FieldList {
                handle: list,
                owner: root,
                fields: vec![parent, first, second],
                ..FieldList::default()
            }),
        );
        let mut payload = XRecord::named("PAYLOAD");
        payload.handle = record;
        payload.owner = root;
        payload.add_entry(XRecordEntry::new(
            160,
            XRecordValue::Int64(9_007_199_254_740_993),
        ));
        payload.add_entry(XRecordEntry::new(
            310,
            XRecordValue::Chunk(vec![0, 1, 127, 128, 255]),
        ));
        payload.add_string(1, "Payload 201 is literal text Δ 雷");
        payload.add_handle(330, first);
        payload.add_handle(340, second);
        doc.objects.insert(record, ObjectType::XRecord(payload));
        let mut view = acadrust::tables::View::new("FUTURE_3D");
        view.handle = Handle::new(offset + 0x206);
        view.direction = acadrust::types::Vector3::new(1.0, 2.0, 3.0);
        view.target = acadrust::types::Vector3::new(100.0, 200.0, 12.0);
        view.twist_angle = std::f64::consts::FRAC_PI_6;
        view.ucs_associated = true;
        view.ucs_origin = acadrust::types::Vector3::new(3.0, 4.0, 5.0);
        doc.views.add(view).unwrap();
        doc
    }

    #[test]
    fn metadata_graph_accepts_handle_aliases_without_rewriting_literals_or_binary_values() {
        let source = metadata_document(0);
        let remapped = metadata_document(0x1000);
        assert!(equivalent(
            &metadata_snapshot(&source).unwrap(),
            &metadata_snapshot(&remapped).unwrap(),
            "metadata"
        )
        .is_ok());
    }

    #[test]
    fn metadata_graph_rejects_changed_field_order_kinds_ownership_and_values() {
        let source = metadata_document(0);
        let snapshot = metadata_snapshot(&source).unwrap();
        for change in [
            "child-order",
            "list-order",
            "ownership",
            "dictionary-kind",
            "expression",
            "int64",
            "binary",
            "reference-kind",
        ] {
            let mut result = source.clone();
            match change {
                "child-order" => {
                    if let ObjectType::Field(value) =
                        result.objects.get_mut(&Handle::new(0x201)).unwrap()
                    {
                        value.child_fields.reverse();
                    }
                }
                "list-order" => {
                    if let ObjectType::FieldList(value) =
                        result.objects.get_mut(&Handle::new(0x204)).unwrap()
                    {
                        value.fields.reverse();
                    }
                }
                "ownership" => {
                    if let ObjectType::Field(value) =
                        result.objects.get_mut(&Handle::new(0x202)).unwrap()
                    {
                        value.owner = Handle::new(0x200);
                    }
                }
                "dictionary-kind" => {
                    if let ObjectType::Dictionary(value) =
                        result.objects.get_mut(&Handle::new(0x200)).unwrap()
                    {
                        value.hard_owner_entries.clear();
                    }
                }
                "expression" => {
                    if let ObjectType::Field(value) =
                        result.objects.get_mut(&Handle::new(0x201)).unwrap()
                    {
                        value.code = value.code.trim().into();
                    }
                }
                "int64" => {
                    if let ObjectType::XRecord(value) =
                        result.objects.get_mut(&Handle::new(0x205)).unwrap()
                    {
                        value.entries[0].value = XRecordValue::Int64(9_007_199_254_740_994);
                    }
                }
                "binary" => {
                    if let ObjectType::XRecord(value) =
                        result.objects.get_mut(&Handle::new(0x205)).unwrap()
                    {
                        value.entries[1].value = XRecordValue::Chunk(vec![0, 1, 127, 128, 254]);
                    }
                }
                "reference-kind" => {
                    if let ObjectType::XRecord(value) =
                        result.objects.get_mut(&Handle::new(0x205)).unwrap()
                    {
                        value.object_references[0].kind = ProxyReferenceKind::HardPointer;
                    }
                }
                _ => unreachable!(),
            }
            assert!(
                metadata_snapshot(&result)
                    .and_then(|result| equivalent(&snapshot, &result, "metadata"))
                    .is_err(),
                "{change}"
            );
        }
    }

    #[test]
    fn metadata_graph_keeps_all_named_view_dimensions_and_camera_fields() {
        let source = metadata_document(0);
        let snapshot = metadata_snapshot(&source).unwrap();
        for change in [
            "target-z",
            "direction-z",
            "ucs-z",
            "twist",
            "lens",
            "perspective",
            "front-clip-eye",
        ] {
            let mut result = source.clone();
            let view = result.views.get_mut("FUTURE_3D").unwrap();
            match change {
                "target-z" => view.target.z = 0.0,
                "direction-z" => view.direction.z = 0.0,
                "ucs-z" => view.ucs_origin.z = 0.0,
                "twist" => view.twist_angle = 0.0,
                "lens" => view.lens_length = 25.0,
                "perspective" => view.perspective = true,
                "front-clip-eye" => view.front_clip_at_eye = true,
                _ => unreachable!(),
            }
            assert!(
                equivalent(&snapshot, &metadata_snapshot(&result).unwrap(), "metadata").is_err(),
                "{change}"
            );
        }
    }

    #[test]
    fn metadata_graph_refuses_incomplete_incoherent_and_missing_objects() {
        for change in [
            "incomplete",
            "schema",
            "reference-count",
            "missing-child",
            "duplicate-key",
            "unknown",
        ] {
            let mut source = metadata_document(0);
            match change {
                "incomplete" => {
                    if let ObjectType::XRecord(value) =
                        source.objects.get_mut(&Handle::new(0x205)).unwrap()
                    {
                        value.entries_complete = false;
                    }
                }
                "schema" => {
                    if let ObjectType::XRecord(value) =
                        source.objects.get_mut(&Handle::new(0x205)).unwrap()
                    {
                        value.entries[0].value = XRecordValue::Double(1.0);
                    }
                }
                "reference-count" => {
                    if let ObjectType::XRecord(value) =
                        source.objects.get_mut(&Handle::new(0x205)).unwrap()
                    {
                        value.object_references.pop();
                    }
                }
                "missing-child" => {
                    source.objects.remove(&Handle::new(0x202));
                }
                "duplicate-key" => {
                    if let ObjectType::Dictionary(value) =
                        source.objects.get_mut(&Handle::new(0x200)).unwrap()
                    {
                        value.add_entry("field", Handle::new(0x204));
                    }
                }
                "unknown" => {
                    source.objects.insert(
                        Handle::new(0x299),
                        ObjectType::Unknown {
                            type_name: "PRIVATE_UNSUPPORTED".into(),
                            handle: Handle::new(0x299),
                            owner: Handle::new(0x200),
                            raw_dxf_codes: None,
                            raw_dwg_data: None,
                            raw_dwg_handle_bits: 0,
                            raw_dwg_version: None,
                        },
                    );
                }
                _ => unreachable!(),
            }
            assert!(metadata_snapshot(&source).is_err(), "{change}");
        }
    }

    #[test]
    fn field_dxf_common_groups_keep_reactors_separate_from_owner_and_field_list_contents() {
        let text = "0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1032\n0\nENDSEC\n0\nSECTION\n2\nOBJECTS\n0\nFIELD\n5\n200\n102\n{ACAD_REACTORS\n330\nA1\n330\nA2\n102\n}\n102\n{ACAD_XDICTIONARY\n360\nF0\n102\n}\n330\nC\n100\nAcDbField\n1\nAcExpr\n2\n Δ expression \n90\n0\n97\n0\n0\nFIELDLIST\n5\n201\n102\n{ACAD_REACTORS\n330\nA3\n102\n}\n102\n{ACAD_XDICTIONARY\n360\nF1\n102\n}\n330\nC\n100\nAcDbIdSet\n90\n1\n330\n200\n100\nAcDbFieldList\n0\nENDSEC\n0\nEOF\n";
        let source = DxfReader::from_reader(std::io::Cursor::new(text.as_bytes()))
            .unwrap()
            .read()
            .unwrap();
        assert_eq!(
            source.object_owner(Handle::new(0x200)),
            Some(Handle::new(0xC))
        );
        assert_eq!(
            source.object_reactors(Handle::new(0x200)),
            vec![Handle::new(0xA1), Handle::new(0xA2)]
        );
        assert_eq!(
            source.extension_dictionary_handle(Handle::new(0x200)),
            Some(Handle::new(0xF0))
        );
        assert_eq!(
            source.object_owner(Handle::new(0x201)),
            Some(Handle::new(0xC))
        );
        assert_eq!(
            source.object_reactors(Handle::new(0x201)),
            vec![Handle::new(0xA3)]
        );
        assert_eq!(
            source.extension_dictionary_handle(Handle::new(0x201)),
            Some(Handle::new(0xF1))
        );
        let ObjectType::FieldList(list) = &source.objects[&Handle::new(0x201)] else {
            panic!("Missing FIELDLIST")
        };
        assert_eq!(list.fields, vec![Handle::new(0x200)]);
    }

    #[test]
    fn integer_semantic_comparison_is_exact_beyond_f64_precision() {
        assert!(equivalent(
            &serde_json::json!(9_007_199_254_740_993_i64),
            &serde_json::json!(9_007_199_254_740_994_i64),
            "int64"
        )
        .is_err());
        assert!(equivalent(
            &serde_json::json!(i64::MIN),
            &serde_json::json!(i64::MIN + 1),
            "int64"
        )
        .is_err());
        assert!(equivalent(
            &serde_json::json!(i64::MAX),
            &serde_json::json!(i64::MAX - 1),
            "int64"
        )
        .is_err());
    }
    #[cfg(windows)]
    #[test]
    fn installs_and_verifies_the_os_process_memory_limit() {
        assert!(windows_job::ProcessLimit::install().is_ok());
    }
}
