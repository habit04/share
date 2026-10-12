//! Offline Windows DWG copies with strict protocol, preflight, OS budget, and reopening checks.
mod spline_packet;
mod validation;
mod windows_job;

use acadrust::objects::ObjectType;
use acadrust::tables::Layer;
use acadrust::{CadDocument, DwgReader, DwgWriter, DxfReader, DxfVersion};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
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

fn verify_reopening(before: &CadDocument, after: &CadDocument) -> Result<(), String> {
    if after.version != DxfVersion::AC1032
        || counts(before) != counts(after)
        || before.entities().count() != after.entities().count()
    {
        return Err("DWG reopening changed the drawing version or entity counts.".into());
    }
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
    #[cfg(windows)]
    #[test]
    fn installs_and_verifies_the_os_process_memory_limit() {
        assert!(windows_job::ProcessLimit::install().is_ok());
    }
}
