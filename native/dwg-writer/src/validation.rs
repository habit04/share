//! Bounded ASCII DXF structure/numeric validation before the third-party parser allocates.
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_BYTES: usize = 128 * 1024 * 1024;
const MAX_LINE: usize = 1024 * 1024;
const MAX_PAIRS: usize = 2_000_000;
const MAX_RECORDS: usize = 250_000;
const MAX_BLOCKS: usize = 20_000;
const MAX_LAYOUTS: usize = 256;

#[derive(Debug)]
pub struct Preflight<'a> {
    pub layers: BTreeSet<&'a str>,
    pub entity_counts: BTreeMap<String, usize>,
    pub pairs: usize,
}

fn entity_supported(kind: &str) -> bool {
    matches!(
        kind,
        "LINE"
            | "CIRCLE"
            | "ARC"
            | "ELLIPSE"
            | "LWPOLYLINE"
            | "TEXT"
            | "MTEXT"
            | "SPLINE"
            | "HATCH"
            | "SOLID"
            | "3DFACE"
            | "INSERT"
            | "MINSERT"
            | "POINT"
            | "RAY"
            | "XLINE"
            | "DIMENSION"
            | "LEADER"
            | "IMAGE"
            | "ACAD_TABLE"
            | "VIEWPORT"
            | "ATTDEF"
            | "ATTRIB"
            | "SEQEND"
            | "BLOCK"
            | "ENDBLK"
    )
}

fn numeric(code: u16, value: &str) -> Result<(), String> {
    let floating = matches!(code, 10..=59 | 110..=149 | 210..=239 | 460..=469 | 1010..=1059);
    let integer = matches!(code, 60..=79 | 90..=99 | 160..=179 | 270..=299 | 370..=389 | 400..=409 | 420..=429 | 440..=459 | 1060..=1071);
    if floating {
        let number: f64 = value
            .trim()
            .parse()
            .map_err(|_| format!("Invalid DXF number in group {code}."))?;
        if !number.is_finite() || number.abs() > 1e100 {
            return Err(format!("Invalid or unbounded DXF number in group {code}."));
        }
    } else if integer {
        value
            .trim()
            .parse::<i64>()
            .map_err(|_| format!("Invalid DXF integer in group {code}."))?;
    }
    Ok(())
}

pub fn validate(text: &str) -> Result<Preflight<'_>, String> {
    if text.is_empty() || text.len() > MAX_BYTES || text.contains('\0') {
        return Err("Invalid or oversized DXF input.".into());
    }
    let mut lines = text.lines();
    let mut section = "";
    let mut section_name_pending = false;
    let mut table_open = false;
    let mut block_open = false;
    let mut eof = false;
    let mut acadver_pending = false;
    let mut source_version = false;
    let mut blocks = 0usize;
    let mut layouts = 0usize;
    let mut records = 0usize;
    let mut record_type = "";
    let mut result = Preflight {
        layers: BTreeSet::new(),
        entity_counts: BTreeMap::new(),
        pairs: 0,
    };
    while let Some(code_line) = lines.next() {
        let value = lines
            .next()
            .ok_or("Incomplete DXF group-code/value pair.")?;
        if code_line.len() > 8 || value.len() > MAX_LINE {
            return Err("DXF line exceeds the supported size.".into());
        }
        let code: u16 = code_line
            .trim()
            .parse()
            .map_err(|_| "Invalid DXF group code.")?;
        if code > 1071 {
            return Err("Invalid DXF group code.".into());
        }
        result.pairs += 1;
        if result.pairs > MAX_PAIRS {
            return Err("DXF group-pair work budget exceeded.".into());
        }
        if eof {
            return Err("DXF contains data after EOF.".into());
        }
        numeric(code, value)?;
        let value = value.trim();
        let count_field = matches!(
            (record_type, code),
            ("LWPOLYLINE", 90) | ("SPLINE", 72..=74) | ("HATCH", 91 | 93 | 97 | 98 | 78 | 79)
        );
        if count_field
            && value
                .parse::<usize>()
                .map_or(true, |count| count > MAX_RECORDS)
        {
            return Err("DXF declared geometry-count work budget exceeded.".into());
        }
        if record_type == "SPLINE"
            && code == 71
            && value
                .parse::<usize>()
                .map_or(true, |degree| !(1..=16).contains(&degree))
        {
            return Err("DXF spline degree exceeds the supported work budget.".into());
        }
        if section_name_pending {
            if code != 2
                || !matches!(
                    value,
                    "HEADER" | "CLASSES" | "TABLES" | "BLOCKS" | "ENTITIES" | "OBJECTS"
                )
            {
                return Err("Invalid or unsupported DXF section.".into());
            }
            section = value;
            section_name_pending = false;
            continue;
        }
        if acadver_pending {
            if code != 1
                || !matches!(
                    value,
                    "AC1015" | "AC1018" | "AC1021" | "AC1024" | "AC1027" | "AC1032"
                )
            {
                return Err(
                    "DWG export expects a supported DXF interchange version written by JCad."
                        .into(),
                );
            }
            source_version = true;
            acadver_pending = false;
        }
        if section == "HEADER" && code == 9 && value == "$ACADVER" {
            acadver_pending = true;
        }
        if code == 8 {
            if value.is_empty() || value.len() > 255 {
                return Err("Invalid DXF layer name.".into());
            }
            result.layers.insert(value);
        }
        if code != 0 {
            continue;
        }
        record_type = value;
        records += 1;
        if records > MAX_RECORDS {
            return Err("DXF record work budget exceeded.".into());
        }
        match value {
            "SECTION" => {
                if !section.is_empty() {
                    return Err("Nested DXF sections are invalid.".into());
                }
                section_name_pending = true;
            }
            "ENDSEC" => {
                if section.is_empty() || table_open || block_open {
                    return Err("Unbalanced DXF section, table or block.".into());
                }
                section = "";
            }
            "EOF" => {
                if !section.is_empty() || section_name_pending || table_open || block_open {
                    return Err("DXF ended inside an unfinished section.".into());
                }
                eof = true;
            }
            "TABLE" if section == "TABLES" => {
                if table_open {
                    return Err("Nested DXF tables are invalid.".into());
                }
                table_open = true;
            }
            "ENDTAB" if section == "TABLES" => {
                if !table_open {
                    return Err("DXF table end has no matching table.".into());
                }
                table_open = false;
            }
            "BLOCK" if section == "BLOCKS" => {
                if block_open {
                    return Err("Nested DXF blocks are invalid.".into());
                }
                block_open = true;
                blocks += 1;
                if blocks > MAX_BLOCKS {
                    return Err("DXF block work budget exceeded.".into());
                }
            }
            "ENDBLK" if section == "BLOCKS" => {
                if !block_open {
                    return Err("DXF block end has no matching block.".into());
                }
                block_open = false;
            }
            "LAYOUT" if section == "OBJECTS" => {
                layouts += 1;
                if layouts > MAX_LAYOUTS {
                    return Err("DXF layout work budget exceeded.".into());
                }
            }
            kind if section == "ENTITIES" || section == "BLOCKS" => {
                if section == "BLOCKS" && !block_open {
                    return Err("DXF block entity occurs outside a block definition.".into());
                }
                if section == "ENTITIES" && matches!(kind, "BLOCK" | "ENDBLK") {
                    return Err("DXF block definition occurs in the entity section.".into());
                }
                if matches!(
                    kind,
                    "REGION"
                        | "3DSOLID"
                        | "BODY"
                        | "ACAD_SURFACE"
                        | "SURFACE"
                        | "ACAD_PROXY_ENTITY"
                ) {
                    return Err("DWG export cannot preserve retained 3D/ACIS objects; save DXF or remove them in a separate copy.".into());
                }
                if !entity_supported(kind) {
                    return Err(format!(
                        "DWG export cannot preserve entity type {}. Save a DXF copy instead.",
                        kind.chars().take(60).collect::<String>()
                    ));
                }
                if !matches!(kind, "BLOCK" | "ENDBLK" | "ATTRIB" | "SEQEND") {
                    *result
                        .entity_counts
                        .entry(if kind == "MINSERT" {
                            "INSERT".to_owned()
                        } else {
                            kind.to_owned()
                        })
                        .or_default() += 1;
                }
            }
            _ if section.is_empty() => return Err("DXF record occurs outside a section.".into()),
            _ => {}
        }
    }
    if !eof || !source_version || section_name_pending || acadver_pending {
        return Err("Incomplete DXF drawing or missing source version.".into());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn drawing(record: &str) -> String {
        format!("0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1015\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n{record}0\nENDSEC\n0\nEOF\n")
    }
    #[test]
    fn complete_source_counts_and_implicit_layers() {
        let text = drawing("0\nLINE\n8\nBORDER\n10\n1.25\n20\n0\n");
        let result = validate(&text).unwrap();
        assert_eq!(result.entity_counts["LINE"], 1);
        assert!(result.layers.contains("BORDER"));
    }
    #[test]
    fn rejects_invalid_pairs_numbers_and_structure() {
        for text in [
            drawing("0\nLINE\n10\nNaN\n"),
            drawing("0\nLINE\n90\n1.5\n"),
            drawing("0\nLINE\n10\nInfinity\n"),
            drawing("0\nLINE\n10\n1e150\n"),
            drawing("0\nLINE\nBAD\n1\n"),
            drawing("").replace("0\nENDSEC\n0\nEOF", "0\nEOF"),
            format!("{}0\nLINE\n", drawing("")),
        ] {
            assert!(validate(&text).is_err());
        }
    }
    #[test]
    fn rejects_each_retained_acis_type_without_treating_text_as_a_type() {
        for kind in ["REGION", "3DSOLID", "BODY", "ACAD_SURFACE"] {
            assert!(validate(&drawing(&format!("0\n{kind}\n")))
                .unwrap_err()
                .contains("retained 3D/ACIS"));
        }
        assert!(validate(&drawing("0\nTEXT\n1\n3DSOLID\n")).is_ok());
    }
    #[test]
    fn rejects_unknown_entities_and_unsupported_source_versions() {
        assert!(validate(&drawing("0\nHELIX\n")).is_err());
        assert!(validate(&drawing("").replace("AC1015", "AC1032")).is_ok());
        assert!(validate(&drawing("").replace("AC1015", "AC9999")).is_err());
        assert!(validate(&drawing("").replace("EOF", "")).is_err());
    }
    #[test]
    fn rejects_nul_long_lines_and_excessive_record_work() {
        assert!(validate(&drawing("0\nTEXT\n1\n\0\n")).is_err());
        assert!(validate(&drawing(&format!(
            "0\nTEXT\n1\n{}\n",
            "x".repeat(MAX_LINE + 1)
        )))
        .is_err());
        assert!(validate(&drawing(&"0\nPOINT\n".repeat(MAX_RECORDS + 1)))
            .unwrap_err()
            .contains("record work budget"));
    }
    #[test]
    fn rejects_declared_counts_and_degrees_before_parser_allocation() {
        for entity in [
            "0\nLWPOLYLINE\n90\n999999999\n",
            "0\nSPLINE\n71\n9999\n",
            "0\nSPLINE\n72\n999999999\n",
            "0\nHATCH\n91\n999999999\n",
        ] {
            assert!(validate(&drawing(entity))
                .unwrap_err()
                .contains("work budget"));
        }
    }
}
