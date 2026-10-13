//! Offline Windows DWG copies with strict protocol, preflight, OS budget, and reopening checks.
mod generated_table_style;
mod source_schema;
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
                let removed: Vec<_> = a
                    .keys()
                    .filter(|key| !b.contains_key(*key))
                    .take(4)
                    .map(|key| key.chars().take(120).collect::<String>())
                    .collect();
                let added: Vec<_> = b
                    .keys()
                    .filter(|key| !a.contains_key(*key))
                    .take(4)
                    .map(|key| key.chars().take(120).collect::<String>())
                    .collect();
                return Err(format!("DWG reopening changed {location} fields (missing: {removed:?}; added: {added:?})."));
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
            | ObjectType::Group(_)
            | ObjectType::BookColor(_)
            | ObjectType::MultiLeaderStyle(_)
            | ObjectType::DictionaryVariable(_)
            | ObjectType::Scale(_)
            | ObjectType::MLineStyle(_)
            | ObjectType::VisualStyle(_)
            | ObjectType::TableStyle(_)
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
                if matches!(
                    key.as_str(),
                    "handle" | "owner" | "Handle" | "handle_value" | "text_style" | "line_type"
                ) || key.ends_with("_handle")
                {
                    canonical_handle(child, aliases)?;
                } else if matches!(
                    key.as_str(),
                    "reactors" | "child_fields" | "referenced_objects" | "fields" | "entities"
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
    let mut value = match object {
        ObjectType::TableStyle(style) if style.modern_style.is_some() => {
            // Compare actual native slots. Legacy row/margin convenience fields are
            // derived from these formats and do not have independent modern slots.
            serde_json::json!({ "TableStyle": {
            "handle": style.handle,
            "owner_handle": style.owner_handle,
            "name": style.name,
            "modern_unknown_byte": style.modern_unknown_byte,
            "modern_unknown_long1": style.modern_unknown_long1,
            "modern_unknown_long2": style.modern_unknown_long2,
            "modern_cell_style_handle": style.modern_cell_style_handle,
            "modern_style": style.modern_style,
            "modern_overrides": style.modern_overrides,
        } })
        }
        // Explicit imported legacy styles keep their complete typed payload.
        // No decoded-shape exemption can remove them from before/after checks.
        _ => serde_json::to_value(object).map_err(|_| "Cannot verify typed metadata fields.")?,
    };
    // GROUP and MLEADERSTYLE names live in their owning dictionary keys, which
    // the graph compares separately. Their binary records have no name slot;
    // the native reader may populate this derived convenience field differently.
    for kind in ["Group", "MultiLeaderStyle", "DictionaryVariable"] {
        if let Some(fields) = value.get_mut(kind).and_then(Value::as_object_mut) {
            fields.remove("name");
        }
    }
    if let Some(elements) = value
        .get_mut("MLineStyle")
        .and_then(|fields| fields.get_mut("elements"))
        .and_then(Value::as_array_mut)
    {
        // These strings identify entries in a case-insensitive symbol table;
        // they are references, unlike the style's literal name/description.
        for element in elements {
            if let Some(name) = element.get_mut("linetype") {
                if let Some(text) = name.as_str() {
                    *name = Value::String(text.to_uppercase());
                }
            }
        }
    }
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
        ObjectType::Group(value) => {
            if value
                .entities
                .iter()
                .any(|handle| doc.get_entity(*handle).is_none())
            {
                return Err("GROUP references a missing or non-entity member.".into());
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
    let header = &doc.header;
    let mut repaired_header = serde_json::json!({
        "dim_fixed_extension_length": header.dim_fixed_extension_length,
        "dim_jog_angle": header.dim_jog_angle,
        "dim_text_fill": header.dim_text_fill,
        "dim_text_fill_color": header.dim_text_fill_color,
        "dim_arc_symbol": header.dim_arc_symbol,
        "dim_fixed_extension_line": header.dim_fixed_extension_line,
        "dim_text_direction": header.dim_text_direction,
        "dwf_3d_precision": header.dwf_3d_precision,
        "polysolid_width": header.polysolid_width,
        "polysolid_height": header.polysolid_height,
        "light_glyph_display": header.light_glyph_display,
        "tilemode_light_sync": header.tilemode_light_sync,
        "real_world_scale": header.real_world_scale,
        "interference_color": header.interference_color,
        "interference_object_style_handle": header.interference_object_style_handle,
        "interference_viewport_style_handle": header.interference_viewport_style_handle,
        "drag_visual_style_handle": header.drag_visual_style_handle,
        "shadow_mode": header.shadow_mode,
        "current_material_handle": header.current_material_handle,
        "dim_text_style_handle": header.dim_text_style_handle,
        "last_saved_by": doc.summary_info.last_saved_by,
    });
    canonicalize_metadata(&mut repaired_header, &aliases)?;
    let mut classes = BTreeMap::new();
    for class in doc.classes.iter() {
        // Class numbers and DWG version words are storage details, not DXF
        // declaration properties. Only the instance count is derived in DXF.
        let definition = serde_json::json!({
            "name": class.dxf_name,
            "cpp_name": class.cpp_class_name,
            "application": class.application_name,
            "proxy_flags": class.proxy_flags,
            "was_zombie": class.was_zombie,
            "is_entity": class.is_an_entity,
        });
        if classes
            .insert(class.dxf_name.to_uppercase(), definition)
            .is_some()
        {
            return Err("Duplicate native CLASS declaration cannot be verified.".into());
        }
    }
    Ok(
        serde_json::json!({ "header": repaired_header, "classes": classes, "views": views, "objects": graph, "common": common, "xdata": xdata }),
    )
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
    let source_schema = source_schema::capture(text)?;
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
    source_schema.verify(&mut document)?;
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
        let document = DxfReader::from_reader(std::io::Cursor::new(source.as_bytes().to_vec()))
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

    fn metadata_style_document() -> CadDocument {
        use acadrust::entities::{EntityType, Line};
        use acadrust::objects::{BookColor, Group, MultiLeaderStyle, TextAttachmentType};
        let mut doc = metadata_document(0);
        let root = Handle::new(0x200);
        let mut members = Vec::new();
        for handle in [0x300, 0x301] {
            let mut line = Line::from_coords(0.0, 0.0, 0.0, 10.0, 0.0, 0.0);
            line.common.handle = Handle::new(handle);
            members.push(doc.add_entity(EntityType::Line(line)).unwrap());
        }
        let mut group = Group::new("OWNED_LINES");
        group.handle = Handle::new(0x207);
        group.owner = root;
        group.description = "Ordered native group Δ 雷".into();
        group.entities = members;
        let mut color = BookColor::new();
        color.handle = Handle::new(0x208);
        color.owner = root;
        color.color = acadrust::types::Color::Rgb {
            r: 0x12,
            g: 0x34,
            b: 0x56,
        };
        color.book_name = "Studio Book".into();
        color.color_name = "Teal 雷".into();
        let mut style = MultiLeaderStyle::new("NATIVE_STYLE");
        style.handle = Handle::new(0x209);
        style.owner_handle = root;
        style.align_space = 0.18;
        style.enable_block_scale = true;
        style.enable_block_rotation = true;
        style.text_top_attachment = TextAttachmentType::CenterOfText;
        style.text_bottom_attachment = TextAttachmentType::CenterOfText;
        style.unknown_flag_298 = true;
        let ObjectType::Dictionary(dictionary) = doc.objects.get_mut(&root).unwrap() else {
            unreachable!()
        };
        dictionary.add_entry("OWNED_LINES", group.handle);
        dictionary.add_entry("TEAL", color.handle);
        dictionary.add_entry("NATIVE_STYLE", style.handle);
        doc.objects.insert(group.handle, ObjectType::Group(group));
        doc.objects
            .insert(color.handle, ObjectType::BookColor(color));
        doc.objects
            .insert(style.handle, ObjectType::MultiLeaderStyle(style));
        doc
    }

    #[test]
    fn metadata_graph_rejects_changed_group_membership_color_books_and_mleaderstyle_fields() {
        let source = metadata_style_document();
        let snapshot = metadata_snapshot(&source).unwrap();
        for change in [
            "group-order",
            "group-member",
            "group-description",
            "group-selectable",
            "group-unnamed",
            "book-color",
            "book-name",
            "color-name",
            "align-space",
            "block-scale",
            "block-rotation",
            "top-attachment",
            "bottom-attachment",
            "flag298",
        ] {
            let mut changed = source.clone();
            match change {
                "group-order" | "group-member" | "group-description" | "group-selectable"
                | "group-unnamed" => {
                    let ObjectType::Group(group) =
                        changed.objects.get_mut(&Handle::new(0x207)).unwrap()
                    else {
                        unreachable!()
                    };
                    match change {
                        "group-order" => group.entities.reverse(),
                        "group-member" => group.entities[1] = group.entities[0],
                        "group-description" => group.description.push('!'),
                        "group-selectable" => group.selectable = !group.selectable,
                        _ => group.unnamed = !group.unnamed,
                    }
                }
                "book-color" | "book-name" | "color-name" => {
                    let ObjectType::BookColor(color) =
                        changed.objects.get_mut(&Handle::new(0x208)).unwrap()
                    else {
                        unreachable!()
                    };
                    match change {
                        "book-color" => color.color = acadrust::types::Color::from_index(2),
                        "book-name" => color.book_name.push('!'),
                        _ => color.color_name.push('!'),
                    }
                }
                _ => {
                    let ObjectType::MultiLeaderStyle(style) =
                        changed.objects.get_mut(&Handle::new(0x209)).unwrap()
                    else {
                        unreachable!()
                    };
                    match change {
                        "align-space" => style.align_space = 0.0,
                        "block-scale" => style.enable_block_scale = false,
                        "block-rotation" => style.enable_block_rotation = false,
                        "top-attachment" => {
                            style.text_top_attachment =
                                acadrust::objects::TextAttachmentType::TopOfTopLine
                        }
                        "bottom-attachment" => {
                            style.text_bottom_attachment =
                                acadrust::objects::TextAttachmentType::BottomOfBottomLine
                        }
                        _ => style.unknown_flag_298 = false,
                    }
                }
            }
            assert!(
                metadata_snapshot(&changed)
                    .and_then(|changed| equivalent(&snapshot, &changed, "metadata"))
                    .is_err(),
                "{change}"
            );
        }
    }

    #[test]
    fn original_autocad_mleaderstyle_preserves_every_previously_omitted_typed_property() {
        let text = include_str!("../tests/fixtures/autocad-mleaderstyle.dxf");
        let doc = DxfReader::from_reader(std::io::Cursor::new(text.as_bytes()))
            .unwrap()
            .read()
            .unwrap();
        let Some(ObjectType::MultiLeaderStyle(style)) = doc.objects.get(&Handle::new(0x16B)) else {
            panic!("Original MLEADERSTYLE identity was lost")
        };
        assert_eq!(style.align_space, 0.18);
        assert_eq!(style.description, "Standard");
        assert_eq!(style.default_text, "");
        assert!(style.enable_block_scale);
        assert!(style.enable_block_rotation);
        assert_eq!(
            style.text_bottom_attachment,
            acadrust::objects::TextAttachmentType::CenterOfText
        );
        assert_eq!(
            style.text_top_attachment,
            acadrust::objects::TextAttachmentType::CenterOfText
        );
        assert!(style.unknown_flag_298);
        assert_eq!(
            style.multileader_draw_order,
            acadrust::objects::MultiLeaderDrawOrderType::LeaderFirst
        );
        assert_eq!(style.line_color, acadrust::types::Color::ByBlock);
        assert_eq!(style.text_color, acadrust::types::Color::ByBlock);
        assert_eq!(style.block_content_color, acadrust::types::Color::ByBlock);
        assert_eq!(doc.object_reactors(style.handle), vec![Handle::new(0x16A)]);
        assert_eq!(doc.object_owner(style.handle), Some(Handle::new(0x16A)));
        let changed = text
            .replace("\r\n", "\n")
            .replace("\n300\n\n", "\n300\nNative text Δ 雷\n");
        assert!(changed.contains("Native text Δ 雷"));
        let changed = DxfReader::from_reader(std::io::Cursor::new(changed.into_bytes()))
            .unwrap()
            .read()
            .unwrap();
        let ObjectType::MultiLeaderStyle(style) = &changed.objects[&Handle::new(0x16B)] else {
            unreachable!()
        };
        assert_eq!(style.description, "Standard");
        assert_eq!(style.default_text, "Native text Δ 雷");
    }

    #[test]
    fn original_autocad_stock_styles_keep_native_properties_selectors_and_common_links() {
        // Exact style/dictionary records extracted from the independent AutoCAD
        // r2018-views-fields DXF, inside a minimal controlled root wrapper.
        let text = include_str!("../tests/fixtures/autocad-stock-styles.dxf");
        let mut source = DxfReader::from_reader(std::io::Cursor::new(text.as_bytes()))
            .unwrap()
            .read()
            .unwrap();
        source_schema::capture(text)
            .unwrap()
            .verify(&mut source)
            .unwrap();
        for handle in [0x140, 0x150, 0x151, 0x152] {
            let ObjectType::VisualStyle(style) = &source.objects[&Handle::new(handle)] else {
                unreachable!()
            };
            assert_eq!(style.properties.len(), 58);
            let mut expected = vec![if handle == 0x140 { 1 } else { 0 }; 58];
            if handle == 0x140 {
                expected[51] = 0;
                expected[52] = 0;
            } else {
                // The original off styles retain an inherited selector2 at
                // edge-modifier slot14; it is not a boolean enable flag.
                expected[14] = 2;
            }
            assert_eq!(
                style
                    .properties
                    .iter()
                    .map(|property| property.enabled)
                    .collect::<Vec<_>>(),
                expected
            );
        }
        assert_eq!(
            source.object_reactors(Handle::new(0x157)),
            vec![Handle::new(0x156)]
        );
        let mut output = std::io::Cursor::new(Vec::new());
        DwgWriter::write_to_writer(&mut output, &source).unwrap();
        output.set_position(0);
        let mut reopened = DwgReader::from_stream(output).read().unwrap();
        for (handle, object) in &source.objects {
            if !matches!(
                object,
                ObjectType::VisualStyle(_) | ObjectType::MLineStyle(_)
            ) {
                continue;
            }
            equivalent(
                &typed_metadata_value(object).unwrap(),
                &typed_metadata_value(&reopened.objects[handle]).unwrap(),
                "original stock styles",
            )
            .unwrap();
            assert_eq!(
                source.object_reactors(*handle),
                reopened.object_reactors(*handle)
            );
        }
        let ObjectType::VisualStyle(style) = reopened.objects.get_mut(&Handle::new(0x150)).unwrap()
        else {
            unreachable!()
        };
        style.properties[31].enabled = 1;
        assert!(equivalent(
            &typed_metadata_value(&source.objects[&Handle::new(0x150)]).unwrap(),
            &typed_metadata_value(&reopened.objects[&Handle::new(0x150)]).unwrap(),
            "selector mutation"
        )
        .is_err());
    }

    #[test]
    fn incomplete_visual_style_bags_refuse_instead_of_materializing_defaults() {
        let text = include_str!("../tests/fixtures/autocad-stock-styles.dxf");
        // Remove one actual typed selector; the remaining boolean must not
        // overwrite its predecessor and trigger default extension synthesis.
        let lines: Vec<_> = text.lines().collect();
        let index = (0..lines.len())
            .step_by(2)
            .find(|index| lines[*index].trim() == "176")
            .unwrap();
        let changed = lines[..index]
            .iter()
            .chain(lines[index + 2..].iter())
            .copied()
            .collect::<Vec<_>>()
            .join("\n");
        assert_ne!(changed, text);
        assert!(
            DxfReader::from_reader(std::io::Cursor::new(changed.as_bytes().to_vec()))
                .unwrap()
                .read()
                .is_err()
        );
    }

    #[test]
    fn multiline_flags_are_decoded_before_baseline_and_survive_binary_storage() {
        let text = include_str!("../tests/fixtures/autocad-stock-styles.dxf");
        let mut lines: Vec<_> = text.lines().map(str::to_owned).collect();
        let start = (0..lines.len())
            .step_by(2)
            .find(|index| lines[*index].trim() == "0" && lines[*index + 1] == "MLINESTYLE")
            .unwrap();
        let flag = (start + 2..lines.len())
            .step_by(2)
            .find(|index| lines[*index].trim() == "70")
            .unwrap();
        lines[flag + 1] = "1907".to_string();
        let changed = lines.join("\n");
        let mut source = DxfReader::from_reader(std::io::Cursor::new(changed.as_bytes().to_vec()))
            .unwrap()
            .read()
            .unwrap();
        source_schema::capture(&changed)
            .unwrap()
            .verify(&mut source)
            .unwrap();
        let ObjectType::MLineStyle(style) = &source.objects[&Handle::new(0x157)] else {
            unreachable!()
        };
        assert_eq!(style.flags.to_bits(), 1907);
        let before = typed_metadata_value(&source.objects[&style.handle]).unwrap();
        let mut output = std::io::Cursor::new(Vec::new());
        DwgWriter::write_to_writer(&mut output, &source).unwrap();
        output.set_position(0);
        let reopened = DwgReader::from_stream(output).read().unwrap();
        equivalent(
            &before,
            &typed_metadata_value(&reopened.objects[&Handle::new(0x157)]).unwrap(),
            "multiline flags DWG",
        )
        .unwrap();
        lines[flag + 1] = "4".to_string();
        assert!(source_schema::capture(&lines.join("\n")).is_err());
    }

    #[test]
    fn dimstyle_second_group70_is_fill_color_not_the_symbol_table_flag() {
        let text = "0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1032\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nDIMSTYLE\n70\n1\n0\nDIMSTYLE\n105\n200\n330\nA\n100\nAcDbSymbolTableRecord\n100\nAcDbDimStyleTableRecord\n2\nControlled\n70\n16\n69\n2\n70\n3\n0\nENDTAB\n0\nENDSEC\n0\nEOF\n";
        let document = DxfReader::from_reader(std::io::Cursor::new(text.as_bytes()))
            .unwrap()
            .read()
            .unwrap();
        let style = document.dim_styles.get("Controlled").unwrap();
        assert!(style.xref_dependent);
        assert!(!style.xref_resolved);
        assert!(!style.xref_reference);
        assert_eq!(style.dimtfill, 2);
        assert_eq!(style.dimtfillclr, 3);
    }

    #[test]
    fn projected_table_style_formats_and_native_wrapper_survive_binary_storage() {
        // Controlled one-override fixture uses the actual projected base/title
        // frames. Complete three-override source proof runs through the separate
        // independent C fixture/readback gate after its decoder rebuild.
        let text = include_str!("../tests/fixtures/projected-table-style.dxf");
        let mut source = DxfReader::from_reader(std::io::Cursor::new(text.as_bytes()))
            .unwrap()
            .read()
            .unwrap();
        source_schema::capture(text)
            .unwrap()
            .verify(&mut source)
            .unwrap();
        let handle = Handle::new(0x155);
        let ObjectType::TableStyle(style) = &source.objects[&handle] else {
            unreachable!()
        };
        assert_eq!(style.modern_unknown_long2, 101);
        assert_eq!(style.modern_overrides.len(), 1);
        assert_eq!(style.modern_overrides[0].0, 1);
        assert_eq!(
            style.modern_overrides[0]
                .1
                .cell_style
                .content_format
                .cell_alignment,
            5
        );
        assert_eq!(
            style.modern_overrides[0]
                .1
                .cell_style
                .content_format
                .text_style,
            Handle::new(0x10B)
        );
        assert_eq!(
            style
                .modern_style
                .as_ref()
                .unwrap()
                .cell_style
                .background_color,
            acadrust::types::Color::None
        );
        assert_eq!(
            style
                .modern_style
                .as_ref()
                .unwrap()
                .cell_style
                .margin_override_flags,
            0
        );
        assert!(style.modern_overrides[0].1.cell_style.borders.is_empty());
        assert_eq!(source.object_reactors(handle), vec![Handle::new(0x154)]);
        let before = typed_metadata_value(&source.objects[&handle]).unwrap();
        let mut output = std::io::Cursor::new(Vec::new());
        DwgWriter::write_to_writer(&mut output, &source).unwrap();
        output.set_position(0);
        let reopened = DwgReader::from_stream(output).read().unwrap();
        equivalent(
            &before,
            &typed_metadata_value(&reopened.objects[&handle]).unwrap(),
            "modern TABLESTYLE DWG",
        )
        .unwrap();
        assert_eq!(
            source.object_reactors(handle),
            reopened.object_reactors(handle)
        );
        // An explicitly empty modern override list is actual source data.
        // It must not invoke generation of the three default legacy rows.
        let ObjectType::TableStyle(style) = source.objects.get_mut(&handle).unwrap() else {
            unreachable!()
        };
        style.modern_overrides.clear();
        style.modern_unknown_long1 = 0x10008;
        let before = typed_metadata_value(&source.objects[&handle]).unwrap();
        let mut output = std::io::Cursor::new(Vec::new());
        DwgWriter::write_to_writer(&mut output, &source).unwrap();
        output.set_position(0);
        let mut reopened = DwgReader::from_stream(output).read().unwrap();
        equivalent(
            &before,
            &typed_metadata_value(&reopened.objects[&handle]).unwrap(),
            "empty TABLESTYLE overrides and native flag bits",
        )
        .unwrap();
        let ObjectType::TableStyle(style) = reopened.objects.get_mut(&handle).unwrap() else {
            unreachable!()
        };
        style.modern_unknown_long2 += 1;
        assert!(equivalent(
            &before,
            &typed_metadata_value(&reopened.objects[&handle]).unwrap(),
            "TABLESTYLE native counter mutation"
        )
        .is_err());
    }

    #[test]
    fn generated_table_style_is_prepared_before_baseline_with_exact_binary_semantics() {
        use acadrust::objects::{CellAlignment, TableStyleFlags};
        use acadrust::types::Color;
        let text = "0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1032\n0\nENDSEC\n0\nEOF\n";
        let mut document = DxfReader::from_reader(std::io::Cursor::new(text.as_bytes()))
            .unwrap()
            .read()
            .unwrap();
        let handle = document
            .objects
            .iter()
            .find_map(|(handle, object)| {
                matches!(object, ObjectType::TableStyle(style) if style.name == "Standard")
                    .then_some(*handle)
            })
            .unwrap();
        let ObjectType::TableStyle(style) = document.objects.get_mut(&handle).unwrap() else {
            unreachable!()
        };
        assert!(style.raw_dxf_codes.is_none() && style.modern_style.is_none());
        style.horizontal_margin = 0.37;
        style.vertical_margin = 0.23;
        style.flags =
            TableStyleFlags::from_bits_retain(8 | TableStyleFlags::TITLE_SUPPRESSED.bits());
        style.data_row_style.text_height = 2.75;
        style.data_row_style.alignment = CellAlignment::BottomRight;
        style.data_row_style.text_color = Color::None;
        style.data_row_style.fill_enabled = true;
        style.data_row_style.fill_color = Color::from_rgb(17, 128, 255);
        style.data_row_style.format_string = "Literal Δ".into();
        style.data_row_style.top_border.is_invisible = true;
        // A dangling explicit reference and missing row name use Standard.
        style.data_row_style.text_style_handle = Some(Handle::new(0xFFFFFF));
        style.data_row_style.text_style_name = "Missing".into();
        let original = style.clone();
        let prepared =
            generated_table_style::canonical_generated_table_style(&document, &original).unwrap();
        let expected = typed_metadata_value(&ObjectType::TableStyle(prepared.clone())).unwrap();
        // Compare the materialization with the actual original generated writer
        // path, not another copy of its construction algorithm.
        let check_binary = |document: &CadDocument| {
            let mut bytes = std::io::Cursor::new(Vec::new());
            DwgWriter::write_to_writer(&mut bytes, document).unwrap();
            bytes.set_position(0);
            let reopened = DwgReader::from_stream(bytes).read().unwrap();
            equivalent(
                &expected,
                &typed_metadata_value(&reopened.objects[&handle]).unwrap(),
                "generated TABLESTYLE DWG",
            )
            .unwrap();
        };
        check_binary(&document);
        source_schema::capture(text)
            .unwrap()
            .verify(&mut document)
            .unwrap();
        assert_eq!(
            document.objects[&handle],
            ObjectType::TableStyle(prepared.clone())
        );
        check_binary(&document);
        assert_eq!(prepared.modern_unknown_long1 & 8, 0);
        assert_eq!(
            prepared
                .modern_overrides
                .iter()
                .map(|entry| entry.0)
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        let base = &prepared.modern_style.as_ref().unwrap().cell_style;
        assert_eq!(base.content_format.text_height, 0.18);
        assert_eq!((base.horizontal_margin, base.vertical_margin), (0.37, 0.23));
        let data = &prepared.modern_overrides[2].1.cell_style;
        assert_eq!(data.content_format.text_height, 2.75);
        assert_eq!(data.content_format.content_color, Color::None);
        assert_eq!(data.background_color, Color::from_rgb(17, 128, 255));
        assert_eq!(
            data.borders
                .iter()
                .map(|grid| grid.index_mask)
                .collect::<Vec<_>>(),
            vec![1, 2, 4, 8, 16, 32]
        );
        assert!(!data.borders[0].border.is_invisible);
        assert_eq!(
            data.content_format.text_style,
            document.text_styles.get("Standard").unwrap().handle
        );
        // Existing native slots stay untouched even for source-absent objects.
        source_schema::capture(text)
            .unwrap()
            .verify(&mut document)
            .unwrap();
        assert_eq!(document.objects[&handle], ObjectType::TableStyle(prepared));
        assert!(generated_table_style::canonical_generated_table_style(
            &document,
            match &document.objects[&handle] {
                ObjectType::TableStyle(style) => style,
                _ => unreachable!(),
            }
        )
        .is_err());
        let mut malformed = document.clone();
        malformed.text_styles.get_mut("Standard").unwrap().handle = Handle::NULL;
        let mut alternate = acadrust::tables::TextStyle::new("Alternate");
        alternate.handle = Handle::new(0xFFFFFE);
        malformed.text_styles.add(alternate).unwrap();
        assert!(
            generated_table_style::canonical_generated_table_style(&malformed, &original)
                .unwrap_err()
                .contains("NULL handle")
        );
    }

    #[test]
    fn table_style_native_wrapper_and_format_budget_are_not_optional() {
        let text =
            include_str!("../tests/fixtures/projected-table-style.dxf").replace("\r\n", "\n");
        for changed in [
            text.replace("{JCAD_TABLESTYLE_NATIVE_V1", "{JCAD_TABLESTYLE_NATIVE_V2"),
            text.replace("92\n1\n93\n1\n102\n}", "92\n2\n93\n1\n102\n}"),
            text.replace("92\n1\n93\n1\n102\n}", "92\n65\n93\n1\n102\n}"),
            text.replace("CONTENTFORMAT_END", "UNKNOWNFORMAT_END"),
        ] {
            assert_ne!(changed, text);
            assert!(
                DxfReader::from_reader(std::io::Cursor::new(changed.as_bytes().to_vec()))
                    .unwrap()
                    .read()
                    .is_err()
            );
        }
    }

    #[test]
    fn table_style_legacy_none_colors_and_trailing_xdata_are_preserved_or_refused() {
        let legacy = "0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1032\n0\nENDSEC\n0\nSECTION\n2\nOBJECTS\n0\nTABLESTYLE\n5\n200\n330\nC\n100\nAcDbTableStyle\n3\nControlled\n70\n0\n71\n0\n7\nStandard\n62\n257\n63\n257\n64\n257\n0\nENDSEC\n0\nEOF\n";
        let mut document = DxfReader::from_reader(std::io::Cursor::new(legacy.as_bytes()))
            .unwrap()
            .read()
            .unwrap();
        let ObjectType::TableStyle(style) = &document.objects[&Handle::new(0x200)] else {
            unreachable!()
        };
        assert_eq!(
            style.data_row_style.text_color,
            acadrust::types::Color::None
        );
        assert_eq!(
            style.data_row_style.fill_color,
            acadrust::types::Color::None
        );
        assert_eq!(
            style.data_row_style.top_border.color,
            acadrust::types::Color::None
        );
        let retained = style.clone();
        source_schema::capture(legacy)
            .unwrap()
            .verify(&mut document)
            .unwrap();
        assert_eq!(
            document.objects[&Handle::new(0x200)],
            ObjectType::TableStyle(retained)
        );
        // Source identity, not raw/modern shape, excludes an explicit record
        // from constructor materialization even if its raw cache is cleared.
        let mut without_raw_cache = document.clone();
        let ObjectType::TableStyle(style) = without_raw_cache
            .objects
            .get_mut(&Handle::new(0x200))
            .unwrap()
        else {
            unreachable!()
        };
        style.raw_dxf_codes = None;
        source_schema::capture(legacy)
            .unwrap()
            .verify(&mut without_raw_cache)
            .unwrap();
        assert!(
            matches!(&without_raw_cache.objects[&Handle::new(0x200)], ObjectType::TableStyle(style) if style.modern_style.is_none())
        );
        assert!(retained_metadata(&document.objects[&Handle::new(0x200)]));
        let baseline = typed_metadata_value(&document.objects[&Handle::new(0x200)]).unwrap();
        let ObjectType::TableStyle(style) = document.objects.get_mut(&Handle::new(0x200)).unwrap()
        else {
            unreachable!()
        };
        style.data_row_style.text_height += 1.0;
        assert!(equivalent(
            &baseline,
            &typed_metadata_value(&document.objects[&Handle::new(0x200)]).unwrap(),
            "retained legacy TABLESTYLE mutation"
        )
        .is_err());
        let invalid = legacy.replace("257", "258");
        assert!(
            DxfReader::from_reader(std::io::Cursor::new(invalid.as_bytes().to_vec()))
                .unwrap()
                .read()
                .is_err()
        );
        let original =
            include_str!("../tests/fixtures/projected-table-style.dxf").replace("\r\n", "\n");
        let text = original.replace(
            "0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nOBJECTS\n",
            "0\nENDTAB\n0\nTABLE\n2\nAPPID\n5\n9\n70\n1\n0\nAPPID\n5\n201\n330\n9\n100\nAcDbSymbolTableRecord\n100\nAcDbRegAppTableRecord\n2\nJCAD_STYLE_PROOF\n70\n0\n0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nOBJECTS\n",
        ).replace(
            "0\nENDSEC\n0\nEOF\n",
            "1001\nJCAD_STYLE_PROOF\n1000\nLiteral \\U+0041 Δ\n1070\n7\n0\nENDSEC\n0\nEOF\n",
        );
        assert_ne!(text, original);
        let mut source = DxfReader::from_reader(std::io::Cursor::new(text.as_bytes().to_vec()))
            .unwrap()
            .read()
            .unwrap();
        source_schema::capture(&text)
            .unwrap()
            .verify(&mut source)
            .unwrap();
        let literals = source_literals(&text).unwrap();
        verify_source_literals(&source, &literals).unwrap();
        assert!(source.app_ids.get("JCAD_STYLE_PROOF").is_some());
        let xdata = source.object_xdata.get(&Handle::new(0x155)).unwrap();
        assert_eq!(xdata.records().len(), 1);
        assert_eq!(
            xdata.records()[0].values,
            vec![
                acadrust::xdata::XDataValue::String("Literal \\U+0041 Δ".into()),
                acadrust::xdata::XDataValue::Integer16(7)
            ]
        );
        let dxf_output = acadrust::DxfWriter::new(&source).write_to_vec().unwrap();
        let dxf_output_text = std::str::from_utf8(&dxf_output).unwrap();
        assert_eq!(
            source_literals(dxf_output_text).unwrap().xdata[&0x155],
            vec!["Literal \\U+0041 Δ".to_string()]
        );
        let dxf_reopened = DxfReader::from_reader(std::io::Cursor::new(dxf_output))
            .unwrap()
            .read()
            .unwrap();
        assert_eq!(
            source.object_xdata[&Handle::new(0x155)].records(),
            dxf_reopened.object_xdata[&Handle::new(0x155)].records()
        );
        assert_eq!(
            metadata_snapshot(&source).unwrap_err(),
            "Drawing metadata contains an unresolved reference."
        );
        // This small fixture omits constructor context. Complete only a test
        // clone; the incomplete imported source must remain refused.
        assert!(!text.contains("\n9\n$DIMTXSTY\n"));
        assert!(!text.contains("\n0\nMLEADERSTYLE\n"));
        let imported_style = source.objects[&Handle::new(0x155)].clone();
        let imported_xdata = source.object_xdata[&Handle::new(0x155)].records().to_vec();
        let standard = source.text_styles.get("Standard").unwrap().handle;
        assert_eq!(standard, Handle::new(0x10B));
        let constructor = CadDocument::new();
        let missing_standard = constructor.header.dim_text_style_handle;
        assert_eq!(source.header.dim_text_style_handle, missing_standard);
        let aliases = metadata_aliases(&source).unwrap();
        assert!(!aliases.contains_key(&missing_standard.value()));
        assert_eq!(
            source
                .objects
                .values()
                .filter(|object| matches!(object, ObjectType::MultiLeaderStyle(_)))
                .count(),
            0
        );
        let mut completed = source.clone();
        completed.header.dim_text_style_handle = standard;
        assert_eq!(completed.objects[&Handle::new(0x155)], imported_style);
        assert_eq!(
            completed.object_xdata[&Handle::new(0x155)].records(),
            imported_xdata.as_slice()
        );
        verify_source_literals(&completed, &literals).unwrap();
        assert!(metadata_snapshot(&source).is_err());
        let before = metadata_snapshot(&completed).unwrap();
        assert!(!before["xdata"].as_object().unwrap().is_empty());
        let mut output = std::io::Cursor::new(Vec::new());
        DwgWriter::write_to_writer(&mut output, &completed).unwrap();
        output.set_position(0);
        let reopened = DwgReader::from_stream(output).read().unwrap();
        let reopened_standard = reopened.text_styles.get("Standard").unwrap().handle;
        assert_eq!(reopened.header.dim_text_style_handle, reopened_standard);
        for object in reopened.objects.values() {
            if let ObjectType::MultiLeaderStyle(style) = object {
                if let Some(text_style) = style.text_style_handle {
                    assert!(reopened
                        .text_styles
                        .iter()
                        .any(|entry| entry.handle == text_style));
                }
            }
        }
        // Both full snapshots require all references to resolve. Compare the
        // complete XDATA payload and the completed header reference context.
        let after = metadata_snapshot(&reopened).unwrap();
        equivalent(
            &before["xdata"],
            &after["xdata"],
            "TABLESTYLE XDATA DWG",
        )
        .unwrap();
        equivalent(
            &before["header"],
            &after["header"],
            "completed test constructor HEADER DWG",
        )
        .unwrap();
    }

    #[test]
    fn declared_last_saved_by_survives_the_native_summary_stream() {
        let text = "0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1032\n9\n$LASTSAVEDBY\n1\nOwner Δ 雷\n0\nENDSEC\n0\nEOF\n";
        let mut document = DxfReader::from_reader(std::io::Cursor::new(text.as_bytes()))
            .unwrap()
            .read()
            .unwrap();
        source_schema::capture(text)
            .unwrap()
            .verify(&mut document)
            .unwrap();
        assert_eq!(document.summary_info.last_saved_by, "Owner Δ 雷");
        let baseline = metadata_snapshot(&document).unwrap();
        let mut output = std::io::Cursor::new(Vec::new());
        DwgWriter::write_to_writer(&mut output, &document).unwrap();
        output.set_position(0);
        let mut reopened = DwgReader::from_stream(output).read().unwrap();
        assert_eq!(reopened.summary_info.last_saved_by, "Owner Δ 雷");
        equivalent(
            &baseline,
            &metadata_snapshot(&reopened).unwrap(),
            "LASTSAVEDBY DWG",
        )
        .unwrap();
        reopened.summary_info.last_saved_by.clear();
        assert!(equivalent(
            &baseline,
            &metadata_snapshot(&reopened).unwrap(),
            "summary mutation"
        )
        .is_err());
    }

    #[test]
    fn creation_dates_keep_stored_milliseconds_in_both_header_streams() {
        // These local/UTC doubles occur in all four actual failing inputs.
        // UTC is stored when declared; an absent UTC date uses the local value.
        let cases: [(f64, f64, i32, i32); 5] = [
            (2461325.845763889, 2461326.054097222, 2461326, 4674000),
            (2461325.845763889, 0.0, 2461325, 73074000),
            (0.0, 2461325.999999999, 2461326, 0),
            (2461325.999999999, 0.0, 2461326, 0),
            (0.0, 0.0, 0, 0),
        ];
        for (local, utc, day, milliseconds) in cases {
            let text = format!(
                "0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1032\n9\n$TDCREATE\n40\n{local}\n9\n$TDUCREATE\n40\n{utc}\n0\nENDSEC\n0\nEOF\n"
            );
            let document = DxfReader::from_reader(std::io::Cursor::new(text.as_bytes()))
                .unwrap()
                .read()
                .unwrap();
            assert_eq!(document.header.create_date_julian, local);
            assert_eq!(document.header.universal_create_date_julian, utc);
            let written = acadrust::io::dwg::dwg_stream_writers::header_writer::write_header(
                DxfVersion::AC1032,
                &document.header,
                0,
            );
            let reopened = acadrust::io::dwg::dwg_stream_readers::header_reader::read_header(
                &written,
                DxfVersion::AC1032,
                0,
            )
            .unwrap();
            let stored = day as f64 + milliseconds as f64 / 86_400_000.0;
            assert_eq!(reopened.universal_create_date_julian, stored);
            // The private header decoder exposes the stored UTC in both fields.
            assert_eq!(reopened.create_date_julian, stored);
            let auxiliary =
                acadrust::io::dwg::dwg_stream_writers::aux_header_writer::write_aux_header(
                    DxfVersion::AC1032,
                    &document.header,
                );
            // R2018 AuxHeader has 69 bytes before its two raw creation longs.
            assert_eq!(i32::from_le_bytes(auxiliary[69..73].try_into().unwrap()), day);
            assert_eq!(
                i32::from_le_bytes(auxiliary[73..77].try_into().unwrap()),
                milliseconds
            );
            if local == 2461325.845763889 && utc == 2461326.054097222 {
                // The real input declares local time five hours before UTC.
                let restored_local = stored - 5.0 / 24.0;
                assert!((restored_local - local).abs() <= 8.0 * f64::EPSILON * local.abs());
            }
        }
    }

    #[test]
    fn original_autocad_header_values_survive_the_actual_binary_header_codec() {
        let text = include_str!("../tests/fixtures/autocad-header.dxf");
        let doc = DxfReader::from_reader(std::io::Cursor::new(text.as_bytes()))
            .unwrap()
            .read()
            .unwrap();
        assert_eq!(doc.header.polysolid_width, 0.25);
        assert_eq!(doc.header.polysolid_height, 4.0);
        assert_eq!(doc.header.light_glyph_display, 1);
        assert_eq!(doc.header.dim_fixed_extension_length, 1.0);
        assert_eq!(doc.header.dim_jog_angle, std::f64::consts::FRAC_PI_4);
        assert!(doc.header.real_world_scale);
        assert_eq!(doc.header.current_material_handle, Handle::new(0x122));
        assert_eq!(
            doc.header.interference_object_style_handle,
            Handle::new(0x144)
        );
        assert_eq!(
            doc.header.interference_viewport_style_handle,
            Handle::new(0x141)
        );
        let written = acadrust::io::dwg::dwg_stream_writers::header_writer::write_header(
            DxfVersion::AC1032,
            &doc.header,
            0,
        );
        let reopened = acadrust::io::dwg::dwg_stream_readers::header_reader::read_header(
            &written,
            DxfVersion::AC1032,
            0,
        )
        .unwrap();
        let value = |header: &acadrust::document::HeaderVariables| {
            serde_json::json!({
                "width": header.polysolid_width, "height": header.polysolid_height,
                "glyphs": header.light_glyph_display, "fixed_length": header.dim_fixed_extension_length,
                "jog": header.dim_jog_angle, "real_world": header.real_world_scale,
                "material": header.current_material_handle, "object_style": header.interference_object_style_handle,
                "viewport_style": header.interference_viewport_style_handle,
                "interference_color": header.interference_color,
            })
        };
        equivalent(&value(&doc.header), &value(&reopened), "original HEADER").unwrap();
    }

    #[test]
    fn source_schema_rejects_unencoded_header_and_unconsumed_object_properties() {
        for body in [
            "9\n$PRIVATE_HEADER\n1\nsecret\n",
            "9\n$UNITMODE\n70\n1\n",
            "9\n$UCSORGTOP\n10\n1\n20\n0\n30\n0\n",
            "9\n$PSOLHEIGHT\n40\n0\n",
        ] {
            let text =
                format!("0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1032\n{body}0\nENDSEC\n0\nEOF\n");
            assert!(source_schema::capture(&text).is_err());
        }
        for kind in [
            "GROUP",
            "DBCOLOR",
            "MLEADERSTYLE",
            "DICTIONARY",
            "DICTIONARYVAR",
            "SCALE",
        ] {
            let text = format!("0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1032\n0\nENDSEC\n0\nSECTION\n2\nOBJECTS\n0\n{kind}\n5\n200\n100\nAcDbObject\n309\nlost property\n0\nENDSEC\n0\nEOF\n");
            assert!(source_schema::capture(&text).is_err(), "{kind}");
        }
        source_schema::capture(include_str!("../tests/fixtures/autocad-header.dxf")).unwrap();
        source_schema::capture(include_str!("../tests/fixtures/autocad-mleaderstyle.dxf")).unwrap();
        let scale = "0\nSECTION\n2\nOBJECTS\n0\nSCALE\n5\n200\n330\n0\n100\nAcDbScale\n70\n0\n300\n1:1\n140\n1\n141\n1\n290\n1\n0\nENDSEC\n0\nEOF\n";
        source_schema::capture(scale).unwrap();
        assert!(source_schema::capture(&scale.replace("70\n0\n", "70\n1\n")).is_err());
    }

    #[test]
    fn source_class_definitions_survive_default_pool_and_native_reopening() {
        // These declarations are the stock definitions used by JCad's fresh
        // DXF drawings; the placeholder is intentionally unused.
        let text = "0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1032\n0\nENDSEC\n0\nSECTION\n2\nCLASSES\n0\nCLASS\n1\nACDBDICTIONARYWDFLT\n2\nAcDbDictionaryWithDefault\n3\nISM\n90\n0\n91\n0\n280\n0\n281\n0\n0\nCLASS\n1\nACDBPLACEHOLDER\n2\nAcDbPlaceHolder\n3\nISM\n90\n0\n91\n0\n280\n0\n281\n0\n0\nENDSEC\n0\nEOF\n";
        // Keep declarations required by the library's generated standard
        // objects, while replacing the two declarations under test.
        let defaults = CadDocument::new();
        let mut extra = String::new();
        for class in defaults.classes.iter().filter(|class| {
            !matches!(
                class.dxf_name.as_str(),
                "ACDBDICTIONARYWDFLT" | "ACDBPLACEHOLDER"
            )
        }) {
            extra.push_str(&format!(
                "0\nCLASS\n1\n{}\n2\n{}\n3\n{}\n90\n{}\n91\n0\n280\n{}\n281\n{}\n",
                class.dxf_name,
                class.cpp_class_name,
                class.application_name,
                class.proxy_flags.0,
                i32::from(class.was_zombie),
                i32::from(class.is_an_entity)
            ));
        }
        let text = text.replace(
            "0\nENDSEC\n0\nEOF\n",
            &format!("{extra}0\nENDSEC\n0\nEOF\n"),
        );
        let document = DxfReader::from_reader(std::io::Cursor::new(text.into_bytes()))
            .unwrap()
            .read()
            .unwrap();
        for name in ["ACDBDICTIONARYWDFLT", "ACDBPLACEHOLDER"] {
            assert_eq!(
                document.classes.get_by_name(name).unwrap().application_name,
                "ISM"
            );
        }
        let before = metadata_snapshot(&document).unwrap()["classes"].clone();
        let mut output = std::io::Cursor::new(Vec::new());
        DwgWriter::write_to_writer(&mut output, &document).unwrap();
        output.set_position(0);
        let reopened = DwgReader::from_stream(output).read().unwrap();
        equivalent(
            &before,
            &metadata_snapshot(&reopened).unwrap()["classes"],
            "source CLASS",
        )
        .unwrap();
        for change in ["app", "cpp", "proxy", "zombie", "entity", "missing"] {
            let mut changed = document.clone();
            if change == "missing" {
                changed.classes.clear();
            } else {
                let mut definitions: Vec<_> = changed.classes.iter().cloned().collect();
                let class = definitions
                    .iter_mut()
                    .find(|class| class.dxf_name == "ACDBPLACEHOLDER")
                    .unwrap();
                match change {
                    "app" => class.application_name = "ObjectDBX Classes".into(),
                    "cpp" => class.cpp_class_name = "AcDbOther".into(),
                    "proxy" => class.proxy_flags = acadrust::classes::ProxyFlags::ERASE_ALLOWED,
                    "zombie" => class.was_zombie = true,
                    "entity" => class.is_an_entity = true,
                    _ => unreachable!(),
                }
                changed.classes.clear();
                for class in definitions {
                    changed.classes.add_or_update(class);
                }
            }
            assert!(
                equivalent(
                    &before,
                    &metadata_snapshot(&changed).unwrap()["classes"],
                    "CLASS mutation"
                )
                .is_err(),
                "{change}"
            );
        }
    }

    #[test]
    fn native_dictionary_global_ownership_keeps_actual_entry_kinds() {
        let text = "0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1032\n0\nENDSEC\n0\nSECTION\n2\nOBJECTS\n0\nDICTIONARY\n5\n200\n330\nC\n100\nAcDbDictionary\n280\n1\n281\n1\n3\nLinkedMetadata\n360\n201\n0\nXRECORD\n5\n201\n330\n200\n100\nAcDbXrecord\n280\n1\n1\nNative owned metadata\n0\nENDSEC\n0\nEOF\n";
        let imported = DxfReader::from_reader(std::io::Cursor::new(text.as_bytes()))
            .unwrap()
            .read()
            .unwrap();
        // The small DXF fragment supplies the owned records, not a complete
        // database. Attach them to a valid root with all standard objects so
        // the native writer does not have to repair an absent NOD/layout tree.
        let mut document = CadDocument::with_version(DxfVersion::AC1032);
        for (handle, object) in imported.objects {
            document.objects.insert(handle, object);
        }
        let root = document.header.named_objects_dict_handle;
        let ObjectType::Dictionary(dictionary) = document.objects.get_mut(&root).unwrap() else {
            unreachable!()
        };
        dictionary.add_entry("OwnedMetadata", Handle::new(0x200));
        source_schema::capture(text)
            .unwrap()
            .verify(&mut document)
            .unwrap();
        let before = metadata_snapshot(&document).unwrap();
        let mut output = std::io::Cursor::new(Vec::new());
        DwgWriter::write_to_writer(&mut output, &document).unwrap();
        output.set_position(0);
        let mut reopened = DwgReader::from_stream(output).read().unwrap();
        equivalent(
            &before,
            &metadata_snapshot(&reopened).unwrap(),
            "hard-owner dictionary DWG",
        )
        .unwrap();
        let ObjectType::Dictionary(dictionary) =
            reopened.objects.get_mut(&Handle::new(0x200)).unwrap()
        else {
            unreachable!()
        };
        assert!(dictionary.hard_owner);
        assert_eq!(
            dictionary.hard_owner_entries,
            vec!["LinkedMetadata".to_string()]
        );
        dictionary.hard_owner = false;
        assert!(equivalent(
            &before,
            &metadata_snapshot(&reopened).unwrap(),
            "hard-owner mutation"
        )
        .is_err());
    }

    #[test]
    fn native_class_object_common_links_are_not_hidden_by_empty_side_caches() {
        let mut document = metadata_document(0);
        let mut object = acadrust::objects::ClassObject::default();
        object.handle = Handle::new(0x299);
        object.owner = Handle::new(0x200);
        object.reactors = vec![object.owner];
        object.xdictionary_handle = Some(Handle::new(0x29A));
        let mut dictionary = acadrust::objects::Dictionary::new();
        dictionary.handle = Handle::new(0x29A);
        dictionary.owner = object.handle;
        document
            .objects
            .insert(dictionary.handle, ObjectType::Dictionary(dictionary));
        document
            .objects
            .insert(object.handle, ObjectType::ClassObject(object));
        assert_eq!(
            document.object_reactors(Handle::new(0x299)),
            vec![Handle::new(0x200)]
        );
        assert_eq!(
            document.extension_dictionary_handle(Handle::new(0x299)),
            Some(Handle::new(0x29A))
        );
        let baseline = metadata_snapshot(&document).unwrap();
        let ObjectType::ClassObject(value) = document.objects.get_mut(&Handle::new(0x299)).unwrap()
        else {
            unreachable!()
        };
        value.reactors.clear();
        assert!(equivalent(
            &baseline,
            &metadata_snapshot(&document).unwrap(),
            "CLASS common mutation"
        )
        .is_err());
    }

    #[test]
    fn explicit_annotation_headers_materialize_owned_objects_and_refuse_retained_conflicts() {
        let text = "0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1032\n9\n$CANNOSCALE\n2\n1:4\n9\n$ANNOALLVISIBLE\n70\n0\n0\nENDSEC\n0\nEOF\n";
        let source = source_schema::capture(text).unwrap();
        let mut document = DxfReader::from_reader(std::io::Cursor::new(text.as_bytes()))
            .unwrap()
            .read()
            .unwrap();
        source.verify(&mut document).unwrap();
        let ObjectType::Dictionary(root) =
            &document.objects[&document.header.named_objects_dict_handle]
        else {
            unreachable!()
        };
        let vars_handle = root.get("AcDbVariableDictionary").unwrap();
        let ObjectType::Dictionary(vars) = &document.objects[&vars_handle] else {
            unreachable!()
        };
        let scale_var = vars.get("CANNOSCALE").unwrap();
        let visible_var = vars.get("ANNOALLVISIBLE").unwrap();
        assert!(
            matches!(&document.objects[&scale_var], ObjectType::DictionaryVariable(value) if value.value == "1:4" && value.owner_handle == vars_handle)
        );
        assert!(
            matches!(&document.objects[&visible_var], ObjectType::DictionaryVariable(value) if value.value == "0" && value.owner_handle == vars_handle)
        );
        assert!(document.objects.values().any(|object| matches!(object, ObjectType::Scale(value) if value.name == "1:4" && value.paper_units == 1.0 && value.drawing_units == 4.0)));
        assert_eq!(document.header.annotation_scale_value, 0.25);
        let before = metadata_snapshot(&document).unwrap();
        source.verify(&mut document).unwrap();
        equivalent(
            &before,
            &metadata_snapshot(&document).unwrap(),
            "idempotent annotations",
        )
        .unwrap();
        let mut output = std::io::Cursor::new(Vec::new());
        DwgWriter::write_to_writer(&mut output, &document).unwrap();
        output.set_position(0);
        let reopened = DwgReader::from_stream(output).read().unwrap();
        equivalent(
            &before,
            &metadata_snapshot(&reopened).unwrap(),
            "owned annotation registry DWG",
        )
        .unwrap();
        for (paper, drawing) in [(f64::MAX, f64::MIN_POSITIVE), (f64::MIN_POSITIVE, f64::MAX)] {
            let mut invalid = document.clone();
            for object in invalid.objects.values_mut() {
                if let ObjectType::Scale(value) = object {
                    if value.name == "1:4" {
                        value.paper_units = paper;
                        value.drawing_units = drawing;
                    }
                }
            }
            assert!(source.verify(&mut invalid).is_err());
        }
        let conflicting = source_schema::capture(&text.replace("1:4", "1:2")).unwrap();
        assert!(conflicting
            .verify(&mut document)
            .unwrap_err()
            .contains("contradicts"));
        let unit_text = text.replace("1:4", "1:1");
        let unit_source = source_schema::capture(&unit_text).unwrap();
        let mut unit_document =
            DxfReader::from_reader(std::io::Cursor::new(unit_text.into_bytes()))
                .unwrap()
                .read()
                .unwrap();
        unit_source.verify(&mut unit_document).unwrap();
        let handle = unit_document.objects.iter().find_map(|(handle, object)| matches!(object, ObjectType::Scale(value) if value.name == "1:1" && !value.is_unit_scale).then_some(*handle)).unwrap();
        let check_unit_roundtrip = |document: &CadDocument| {
            let baseline = metadata_snapshot(document).unwrap();
            let mut bytes = std::io::Cursor::new(Vec::new());
            DwgWriter::write_to_writer(&mut bytes, document).unwrap();
            bytes.set_position(0);
            let reopened = DwgReader::from_stream(bytes).read().unwrap();
            equivalent(
                &baseline,
                &metadata_snapshot(&reopened).unwrap(),
                "unit SCALE native flags",
            )
            .unwrap();
        };
        check_unit_roundtrip(&unit_document);
        let ObjectType::Scale(value) = unit_document.objects.get_mut(&handle).unwrap() else {
            unreachable!()
        };
        value.is_unit_scale = true;
        unit_source.verify(&mut unit_document).unwrap();
        assert!(
            matches!(&unit_document.objects[&handle], ObjectType::Scale(value) if value.is_unit_scale)
        );
        check_unit_roundtrip(&unit_document);
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
