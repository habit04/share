//! Source coverage before the native parser establishes its typed baseline.
//! Known opaque object schemas reject unconsumed groups. All OBJECTS identities
//! must survive import; the independent C postflight checks other typed classes.
use acadrust::{objects::ObjectType, tables::TableEntry, types::Handle, CadDocument};
use std::collections::BTreeMap;

fn root_dictionary(document: &mut CadDocument) -> Result<Handle, String> {
    let known = document.header.named_objects_dict_handle;
    if matches!(document.objects.get(&known), Some(ObjectType::Dictionary(value)) if value.owner.is_null())
    {
        return Ok(known);
    }
    let roots: Vec<_> = document
        .objects
        .iter()
        .filter_map(|(handle, object)| {
            matches!(object, ObjectType::Dictionary(value) if value.owner.is_null())
                .then_some(*handle)
        })
        .collect();
    if roots.len() != 1 {
        return Err(refusal(
            "annotation registry has no unique named-object root",
        ));
    }
    document.header.named_objects_dict_handle = roots[0];
    Ok(roots[0])
}
fn dictionary_child(
    document: &mut CadDocument,
    owner: Handle,
    key: &str,
) -> Result<Handle, String> {
    let Some(ObjectType::Dictionary(parent)) = document.objects.get(&owner) else {
        return Err(refusal("annotation registry owner is not a dictionary"));
    };
    let matches: Vec<_> = parent
        .entries
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case(key))
        .map(|(_, handle)| *handle)
        .collect();
    if matches.len() > 1 {
        return Err(refusal("ambiguous annotation registry key"));
    }
    if let Some(handle) = matches.first() {
        return if matches!(document.objects.get(handle), Some(ObjectType::Dictionary(value)) if value.owner == owner)
        {
            Ok(*handle)
        } else {
            Err(refusal("annotation registry class/ownership"))
        };
    }
    if document.objects.len() >= 250_000 {
        return Err(refusal("annotation object budget"));
    }
    let handle = document.allocate_handle();
    let mut child = acadrust::objects::Dictionary::new();
    child.handle = handle;
    child.owner = owner;
    child.reactors.push(owner);
    document
        .objects
        .insert(handle, ObjectType::Dictionary(child));
    let Some(ObjectType::Dictionary(parent)) = document.objects.get_mut(&owner) else {
        unreachable!()
    };
    parent.add_entry(key, handle);
    Ok(handle)
}
fn variable(
    document: &mut CadDocument,
    dictionary: Handle,
    key: &str,
    value: &str,
) -> Result<(), String> {
    let Some(ObjectType::Dictionary(parent)) = document.objects.get(&dictionary) else {
        return Err(refusal("annotation variable owner"));
    };
    let matches: Vec<_> = parent
        .entries
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case(key))
        .map(|(_, handle)| *handle)
        .collect();
    if matches.len() > 1 {
        return Err(refusal("duplicate annotation variable"));
    }
    if let Some(handle) = matches.first() {
        let Some(ObjectType::DictionaryVariable(existing)) = document.objects.get(handle) else {
            return Err(refusal("annotation variable has an unsupported class"));
        };
        if existing.owner_handle != dictionary || existing.value != value {
            return Err(refusal(&format!(
                "retained {key} contradicts its explicit HEADER value"
            )));
        }
        return Ok(());
    }
    if document.objects.len() >= 250_000 {
        return Err(refusal("annotation object budget"));
    }
    let handle = document.allocate_handle();
    let mut item = acadrust::objects::DictionaryVariable::new(key, value);
    item.handle = handle;
    item.owner_handle = dictionary;
    document
        .objects
        .insert(handle, ObjectType::DictionaryVariable(item));
    if !document.set_annotation_owner_reactor(handle) {
        return Err(refusal("annotation variable owner reactor"));
    }
    let Some(ObjectType::Dictionary(parent)) = document.objects.get_mut(&dictionary) else {
        unreachable!()
    };
    parent.add_entry(key, handle);
    Ok(())
}
fn annotation_scale(document: &mut CadDocument, root: Handle, name: &str) -> Result<f64, String> {
    if name.is_empty() || name.len() > 255 || name.trim() != name {
        return Err(refusal("annotation scale name"));
    }
    let dictionary = dictionary_child(document, root, "ACAD_SCALELIST")?;
    let Some(ObjectType::Dictionary(list)) = document.objects.get(&dictionary) else {
        unreachable!()
    };
    let matches: Vec<_> = list
        .entries
        .iter()
        .filter_map(|(_, handle)| match document.objects.get(handle) {
            Some(ObjectType::Scale(value)) if value.name.eq_ignore_ascii_case(name) => {
                Some((*handle, value))
            }
            _ => None,
        })
        .collect();
    if matches.len() > 1 {
        return Err(refusal("ambiguous annotation scale"));
    }
    if let Some((_, scale)) = matches.first() {
        let factor = scale.paper_units / scale.drawing_units;
        if scale.owner_handle != dictionary
            || !scale.paper_units.is_finite()
            || !scale.drawing_units.is_finite()
            || scale.paper_units <= 0.0
            || scale.drawing_units <= 0.0
            || !factor.is_finite()
            || factor <= 0.0
        {
            return Err(refusal("annotation scale units/ownership"));
        }
        return Ok(factor);
    }
    let Some((paper, drawing)) = name.split_once(':') else {
        return Err(refusal("annotation scale has no retained definition"));
    };
    let paper: f64 = paper
        .parse()
        .map_err(|_| refusal("annotation scale ratio"))?;
    let drawing: f64 = drawing
        .parse()
        .map_err(|_| refusal("annotation scale ratio"))?;
    if !paper.is_finite()
        || !drawing.is_finite()
        || paper <= 0.0
        || drawing <= 0.0
        || !(paper / drawing).is_finite()
        || paper / drawing <= 0.0
    {
        return Err(refusal("annotation scale ratio"));
    }
    if document.objects.len() >= 250_000 {
        return Err(refusal("annotation object budget"));
    }
    let handle = document.allocate_handle();
    let mut scale = acadrust::objects::Scale::new(name, paper, drawing);
    scale.handle = handle;
    scale.owner_handle = dictionary;
    document.objects.insert(handle, ObjectType::Scale(scale));
    if !document.set_annotation_owner_reactor(handle) {
        return Err(refusal("annotation scale owner reactor"));
    }
    let Some(ObjectType::Dictionary(list)) = document.objects.get_mut(&dictionary) else {
        unreachable!()
    };
    if list
        .entries
        .iter()
        .any(|(key, _)| key.eq_ignore_ascii_case(name))
    {
        return Err(refusal("annotation scale key already names another object"));
    }
    list.add_entry(name, handle);
    Ok(paper / drawing)
}

#[derive(Default)]
pub struct SourceSchema {
    headers: BTreeMap<String, Vec<(i32, String)>>,
    objects: BTreeMap<u64, String>,
}

fn refusal(detail: &str) -> String {
    format!("Unsupported retained metadata schema: {detail}. Save a DXF copy instead.")
}
fn scalar(groups: &[(i32, String)], code: i32) -> Result<&str, String> {
    if groups.len() != 1 || groups[0].0 != code {
        return Err(refusal("HEADER group count/type"));
    }
    Ok(groups[0].1.trim())
}

// These are literal encoded values in the content-pinned header_writer.rs:
// UNITMODE=0; NULL UCS bases/orthographic references and dimension linetypes;
// six model/paper orthographic origins each written as Vector3::ZERO.
// A nondefault source value is refused rather than exempted as a stock template.
fn fixed_header(name: &str, groups: &[(i32, String)]) -> Result<bool, String> {
    if name == "$UNITMODE" {
        return Ok(scalar(groups, 70)? == "0");
    }
    if matches!(
        name,
        "$UCSORTHOREF" | "$PUCSORTHOREF" | "$PUCSBASE" | "$DIMLTYPE" | "$DIMLTEX1" | "$DIMLTEX2"
    ) {
        return Ok(scalar(groups, if name.starts_with("$DIM") { 6 } else { 2 })?.is_empty());
    }
    if ["$UCSORG", "$PUCSORG"].iter().any(|prefix| {
        name.strip_prefix(prefix).is_some_and(|suffix| {
            ["TOP", "BOTTOM", "LEFT", "RIGHT", "FRONT", "BACK"].contains(&suffix)
        })
    }) {
        return Ok(groups.len() == 3
            && groups
                .iter()
                .zip([10, 20, 30])
                .all(|((code, value), wanted)| {
                    *code == wanted && value.trim().parse::<f64>() == Ok(0.0)
                }));
    }
    Ok(false)
}

fn repaired_header(name: &str) -> Option<(&'static str, i32)> {
    Some(match name {
        "$DIMFXL" => ("dim_fixed_extension_length", 40),
        "$DIMJOGANG" => ("dim_jog_angle", 40),
        "$DIMTFILL" => ("dim_text_fill", 70),
        "$DIMTFILLCLR" => ("dim_text_fill_color", 70),
        "$DIMARCSYM" => ("dim_arc_symbol", 70),
        "$DIMFXLON" => ("dim_fixed_extension_line", 70),
        "$DIMTXTDIRECTION" => ("dim_text_direction", 70),
        "$3DDWFPREC" => ("dwf_3d_precision", 40),
        "$PSOLWIDTH" => ("polysolid_width", 40),
        "$PSOLHEIGHT" => ("polysolid_height", 40),
        "$LIGHTGLYPHDISPLAY" => ("light_glyph_display", 280),
        "$TILEMODELIGHTSYNCH" => ("tilemode_light_sync", 280),
        "$REALWORLDSCALE" => ("real_world_scale", 290),
        "$INTERFERECOLOR" => ("interference_color", 62),
        "$INTERFEREOBJVS" => ("interference_object_style_handle", 345),
        "$INTERFEREVPVS" => ("interference_viewport_style_handle", 346),
        "$DRAGVS" => ("drag_visual_style_handle", 349),
        "$CSHADOW" => ("shadow_mode", 280),
        "$CMATERIAL" => ("current_material_handle", 347),
        _ => return None,
    })
}

fn object_group(
    kind: &str,
    code: i32,
    value: &str,
    context: &mut String,
    xdata: &mut bool,
) -> Result<(), String> {
    if code == 1001 {
        *xdata = true;
    }
    if *xdata {
        return Ok(());
    } // typed XDATA and exact literals have separate guards
    if code == 102 {
        if value == "}" {
            context.clear();
            return Ok(());
        }
        if !context.is_empty() || !matches!(value, "{ACAD_REACTORS" | "{ACAD_XDICTIONARY") {
            return Err(refusal("unknown or nested common object group"));
        }
        *context = value.into();
        return Ok(());
    }
    if !context.is_empty() {
        let expected = if context == "{ACAD_REACTORS" {
            330
        } else {
            360
        };
        return if code == expected {
            Ok(())
        } else {
            Err(refusal("unconsumed common object property"))
        };
    }
    if matches!(code, 5 | 100 | 330 | 999) {
        return Ok(());
    }
    let supported = match kind {
        "DICTIONARY" => matches!(code, 3 | 280 | 281 | 350 | 360),
        "ACDBDICTIONARYWDFLT" => matches!(code, 3 | 280 | 281 | 340 | 350 | 360),
        "FIELD" => {
            matches!(code, 1 | 2 | 3 | 6 | 7 | 9 | 10 | 20 | 30 | 40 | 70 | 90..=98 | 140 | 300..=304 | 310 | 331 | 360)
        }
        "FIELDLIST" => matches!(code, 90 | 290),
        "GROUP" => matches!(code, 300 | 70 | 71 | 340),
        "DBCOLOR" => matches!(code, 1 | 2 | 62 | 420 | 430),
        "DICTIONARYVAR" => matches!(code, 1 | 280),
        "SCALE" => matches!(code, 300 | 140 | 141 | 290),
        "MLEADERSTYLE" => {
            matches!(code, 3 | 300 | 304 | 40..=47 | 49 | 90..=94 | 140..=143 | 170..=178 | 271..=273 | 290..=298 | 340..=343)
                || code == 179 && value.trim().parse::<i32>() == Ok(2)
        } // binary writer's fixed R2010 class version
        _ => true, // independently compared by the bundled C postflight before commit
    };
    if supported {
        Ok(())
    } else {
        Err(refusal(&format!("{kind} group {code}")))
    }
}

pub fn capture(text: &str) -> Result<SourceSchema, String> {
    let mut source = SourceSchema::default();
    let mut lines = text.lines();
    let mut section = "";
    let mut pending_section = false;
    let mut header = String::new();
    let mut kind = String::new();
    let mut handle = None;
    let mut context = String::new();
    let mut xdata = false;
    let finish = |kind: &str,
                  handle: Option<u64>,
                  context: &str,
                  source: &mut SourceSchema|
     -> Result<(), String> {
        if kind.is_empty() {
            return Ok(());
        }
        if !context.is_empty() {
            return Err(refusal("unfinished common object group"));
        }
        let handle = handle
            .filter(|handle| *handle != 0)
            .ok_or_else(|| refusal("OBJECTS record has no exact source handle"))?;
        if source.objects.insert(handle, kind.into()).is_some() {
            return Err(refusal("duplicate OBJECTS identity"));
        }
        Ok(())
    };
    let mut work = 0usize;
    while let Some(raw_code) = lines.next() {
        let value = lines
            .next()
            .ok_or_else(|| refusal("incomplete group pair"))?;
        let code = raw_code
            .trim()
            .parse::<i32>()
            .map_err(|_| refusal("invalid group code"))?;
        work += 1;
        if work > 2_000_000 {
            return Err(refusal("source work budget"));
        }
        if code == 0 {
            finish(&kind, handle, &context, &mut source)?;
            kind.clear();
            handle = None;
            context.clear();
            xdata = false;
            if value == "SECTION" {
                pending_section = true;
            } else if value == "ENDSEC" {
                section = "";
                header.clear();
            } else if section == "OBJECTS" {
                if value.len() > 255 {
                    return Err(refusal("object type length"));
                }
                kind = value.into();
            }
            continue;
        }
        if pending_section && code == 2 {
            section = value;
            pending_section = false;
            continue;
        }
        if section == "HEADER" {
            if code == 9 {
                if value.len() > 64
                    || source.headers.len() >= 512
                    || source.headers.contains_key(value)
                {
                    return Err(refusal("HEADER variable identity/budget"));
                }
                header = value.into();
                source.headers.insert(header.clone(), Vec::new());
            } else if !header.is_empty() {
                let groups = source.headers.get_mut(&header).unwrap();
                if groups.len() >= 32 {
                    return Err(refusal("HEADER variable group budget"));
                }
                groups.push((code, value.into()));
            }
        } else if !kind.is_empty() {
            if code == 5 && !xdata && context.is_empty() {
                handle = Some(
                    u64::from_str_radix(value.trim(), 16).map_err(|_| refusal("OBJECTS handle"))?,
                );
            }
            object_group(&kind, code, value, &mut context, &mut xdata)?;
        }
    }
    finish(&kind, handle, &context, &mut source)?;
    for (name, groups) in &source.headers {
        if !PARSED_HEADER_VARIABLES.contains(&name.as_str())
            && !matches!(name.as_str(), "$DIMTXSTY" | "$ANNOALLVISIBLE")
            && !fixed_header(name, groups)?
        {
            return Err(refusal(&format!("HEADER {name}")));
        }
        if name == "$ANNOALLVISIBLE" && !["0", "1"].contains(&scalar(groups, 70)?) {
            return Err(refusal(name));
        }
        if let Some((_, code)) = repaired_header(name) {
            let raw = scalar(groups, code)?;
            if ["$PSOLWIDTH", "$PSOLHEIGHT"].contains(&name.as_str())
                && !raw
                    .parse::<f64>()
                    .is_ok_and(|value| value.is_finite() && value > 0.0)
            {
                return Err(refusal(name));
            }
            let allowed = match name.as_str() {
                "$DIMFXLON" | "$DIMTXTDIRECTION" | "$REALWORLDSCALE" | "$TILEMODELIGHTSYNCH" => {
                    Some(1)
                }
                "$LIGHTGLYPHDISPLAY" | "$DIMTFILL" | "$DIMARCSYM" => Some(2),
                "$CSHADOW" => Some(3),
                _ => None,
            };
            if let Some(maximum) = allowed {
                if !raw
                    .parse::<i32>()
                    .is_ok_and(|value| (0..=maximum).contains(&value))
                {
                    return Err(refusal(name));
                }
            }
        }
    }
    Ok(source)
}

impl SourceSchema {
    pub fn verify(&self, document: &mut CadDocument) -> Result<(), String> {
        for (handle, kind) in &self.objects {
            let object = document.objects.get(&Handle::new(*handle)).ok_or_else(|| {
                refusal(&format!("{kind} source identity disappeared during import"))
            })?;
            let compatible = match kind.as_str() {
                "GROUP" => matches!(object, ObjectType::Group(_)),
                "DBCOLOR" => matches!(object, ObjectType::BookColor(_)),
                "MLEADERSTYLE" => matches!(object, ObjectType::MultiLeaderStyle(_)),
                "DICTIONARYVAR" => matches!(object, ObjectType::DictionaryVariable(_)),
                "SCALE" => matches!(object, ObjectType::Scale(_)),
                _ => true,
            };
            if !compatible {
                return Err(refusal("source object class changed during import"));
            }
        }
        if self.headers.contains_key("$CANNOSCALE") || self.headers.contains_key("$ANNOALLVISIBLE")
        {
            let root = root_dictionary(document)?;
            let dictionary = dictionary_child(document, root, "AcDbVariableDictionary")?;
            if let Some(groups) = self.headers.get("$CANNOSCALE") {
                let name = scalar(groups, 2)?;
                variable(document, dictionary, "CANNOSCALE", name)?;
                let factor = annotation_scale(document, root, name)?;
                if let Some(groups) = self.headers.get("$CANNOSCALEVALUE") {
                    let declared = scalar(groups, 40)?
                        .parse::<f64>()
                        .map_err(|_| refusal("CANNOSCALEVALUE"))?;
                    if !declared.is_finite()
                        || (declared - factor).abs() > 1e-10 * factor.abs().max(1.0)
                    {
                        return Err(refusal("CANNOSCALEVALUE contradicts retained SCALE units"));
                    }
                }
                document.header.current_annotation_scale = name.into();
                document.header.annotation_scale_value = factor;
            }
            if let Some(groups) = self.headers.get("$ANNOALLVISIBLE") {
                variable(document, dictionary, "ANNOALLVISIBLE", scalar(groups, 70)?)?;
            }
            for (name, cpp) in [
                ("DICTIONARYVAR", "AcDbDictionaryVar"),
                ("SCALE", "AcDbScale"),
            ] {
                if !document.classes.contains(name)
                    && document.objects.values().any(|object| {
                        matches!(
                            (name, object),
                            ("DICTIONARYVAR", ObjectType::DictionaryVariable(_))
                                | ("SCALE", ObjectType::Scale(_))
                        )
                    })
                {
                    document
                        .classes
                        .add_or_update(acadrust::classes::DxfClass::new(name, cpp));
                }
            }
        }
        if let Some(groups) = self.headers.get("$DIMTXSTY") {
            let name = scalar(groups, 7)?;
            document.header.dim_text_style_handle = document
                .text_styles
                .get(name)
                .ok_or_else(|| refusal("DIMTXSTY references a missing text style"))?
                .handle();
        } else if document.header.dim_text_style_handle.is_null() {
            // The pinned binary writer uses Standard when DXF declares no DIMTXSTY.
            // Materialize that same default before taking the checked baseline.
            document.header.dim_text_style_handle = document
                .text_styles
                .get("Standard")
                .ok_or_else(|| refusal("default dimension text style is missing"))?
                .handle();
        }
        let typed =
            serde_json::to_value(&document.header).map_err(|_| refusal("HEADER serialization"))?;
        for (name, groups) in &self.headers {
            let Some((field, code)) = repaired_header(name) else {
                continue;
            };
            let raw = scalar(groups, code)?;
            let value = &typed[field];
            let preserved = if field.ends_with("_handle") {
                u64::from_str_radix(raw, 16).ok() == value.as_u64()
            } else if let Some(actual) = value.as_bool() {
                raw.parse::<i32>()
                    .is_ok_and(|expected| actual == (expected != 0))
            } else if let Some(actual) = value.as_f64() {
                raw.parse::<f64>().is_ok_and(|expected| {
                    actual.is_finite()
                        && expected.is_finite()
                        && (actual - expected).abs() <= 1e-10 * expected.abs().max(1.0)
                })
            } else if matches!(name.as_str(), "$DIMTFILLCLR" | "$INTERFERECOLOR") {
                let wanted = acadrust::types::Color::from_index(
                    raw.parse::<i16>().map_err(|_| refusal(name))?,
                );
                serde_json::to_value(wanted).map_err(|_| refusal(name))? == *value
            } else {
                false
            };
            if !preserved {
                return Err(refusal(&format!(
                    "HEADER {name} changed before the baseline"
                )));
            }
        }
        Ok(())
    }
}

// Generated from the exact content-pinned DXF header decoder. This is input
// consumption coverage, not a guarantee of binary encoding; C postflight checks
// the emitted values independently before any external destination is replaced.
const PARSED_HEADER_VARIABLES: &[&str] = &[
    "$3DDWFPREC",
    "$ACADMAINTVER",
    "$ACADVER",
    "$ANGBASE",
    "$ANGDIR",
    "$ATTDIA",
    "$ATTMODE",
    "$ATTREQ",
    "$AUNITS",
    "$AUPREC",
    "$BLIPMODE",
    "$CAMERADISPLAY",
    "$CAMERAHEIGHT",
    "$CANNOSCALE",
    "$CANNOSCALEVALUE",
    "$CECOLOR",
    "$CELTSCALE",
    "$CELTYPE",
    "$CELWEIGHT",
    "$CEPSNTYPE",
    "$CHAMFERA",
    "$CHAMFERB",
    "$CHAMFERC",
    "$CHAMFERD",
    "$CLAYER",
    "$CMATERIAL",
    "$CMLEADERSTYLE",
    "$CMLJUST",
    "$CMLSCALE",
    "$CMLSTYLE",
    "$COORDS",
    "$CSHADOW",
    "$CTABLESTYLE",
    "$DELOBJ",
    "$DGNFRAME",
    "$DIMADEC",
    "$DIMALT",
    "$DIMALTD",
    "$DIMALTF",
    "$DIMALTRND",
    "$DIMALTTD",
    "$DIMALTTZ",
    "$DIMALTU",
    "$DIMALTZ",
    "$DIMAPOST",
    "$DIMARCSYM",
    "$DIMASO",
    "$DIMASSOC",
    "$DIMASZ",
    "$DIMATFIT",
    "$DIMAUNIT",
    "$DIMAZIN",
    "$DIMBLK",
    "$DIMBLK1",
    "$DIMBLK2",
    "$DIMCEN",
    "$DIMCLRD",
    "$DIMCLRE",
    "$DIMCLRT",
    "$DIMDEC",
    "$DIMDLE",
    "$DIMDLI",
    "$DIMDSEP",
    "$DIMEXE",
    "$DIMEXO",
    "$DIMFIT",
    "$DIMFRAC",
    "$DIMFXL",
    "$DIMFXLON",
    "$DIMGAP",
    "$DIMJOGANG",
    "$DIMJUST",
    "$DIMLDRBLK",
    "$DIMLFAC",
    "$DIMLIM",
    "$DIMLUNIT",
    "$DIMLWD",
    "$DIMLWE",
    "$DIMPOST",
    "$DIMRND",
    "$DIMSAH",
    "$DIMSCALE",
    "$DIMSD1",
    "$DIMSD2",
    "$DIMSE1",
    "$DIMSE2",
    "$DIMSHO",
    "$DIMSOXD",
    "$DIMSTYLE",
    "$DIMTAD",
    "$DIMTDEC",
    "$DIMTFAC",
    "$DIMTFILL",
    "$DIMTFILLCLR",
    "$DIMTIH",
    "$DIMTIX",
    "$DIMTM",
    "$DIMTMOVE",
    "$DIMTOFL",
    "$DIMTOH",
    "$DIMTOL",
    "$DIMTOLJ",
    "$DIMTP",
    "$DIMTSZ",
    "$DIMTVP",
    "$DIMTXT",
    "$DIMTXTDIRECTION",
    "$DIMTZIN",
    "$DIMUPT",
    "$DIMZIN",
    "$DISPSILH",
    "$DRAGMODE",
    "$DRAGVS",
    "$DWFFRAME",
    "$DWGCODEPAGE",
    "$ELEVATION",
    "$ENDCAPS",
    "$EXTMAX",
    "$EXTMIN",
    "$EXTNAMES",
    "$FACETRES",
    "$FILLETRAD",
    "$FILLMODE",
    "$FINGERPRINTGUID",
    "$HALOGAP",
    "$HANDSEED",
    "$HIDETEXT",
    "$HYPERLINKBASE",
    "$INDEXCTL",
    "$INSBASE",
    "$INSUNITS",
    "$INTERFERECOLOR",
    "$INTERFEREOBJVS",
    "$INTERFEREVPVS",
    "$INTERSECTIONCOLOR",
    "$INTERSECTIONDISPLAY",
    "$ISOLINES",
    "$JOINSTYLE",
    "$LASTSAVEDBY",
    "$LATITUDE",
    "$LENSLENGTH",
    "$LIGHTGLYPHDISPLAY",
    "$LIMCHECK",
    "$LIMMAX",
    "$LIMMIN",
    "$LOFTANG1",
    "$LOFTANG2",
    "$LOFTMAG1",
    "$LOFTMAG2",
    "$LOFTNORMALS",
    "$LOFTPARAM",
    "$LONGITUDE",
    "$LTSCALE",
    "$LUNITS",
    "$LUPREC",
    "$LWDISPLAY",
    "$MAXACTVP",
    "$MEASUREMENT",
    "$MENU",
    "$MIRRTEXT",
    "$NORTHDIRECTION",
    "$OBSCOLOR",
    "$OBSLTYPE",
    "$OLESTARTUP",
    "$ORTHOMODE",
    "$OSMODE",
    "$PDMODE",
    "$PDSIZE",
    "$PELEVATION",
    "$PEXTMAX",
    "$PEXTMIN",
    "$PICKSTYLE",
    "$PINSBASE",
    "$PLIMCHECK",
    "$PLIMMAX",
    "$PLIMMIN",
    "$PLINEGEN",
    "$PLINEWID",
    "$PROJECTNAME",
    "$PROXYGRAPHICS",
    "$PSLTSCALE",
    "$PSOLHEIGHT",
    "$PSOLWIDTH",
    "$PSTYLEMODE",
    "$PSVPSCALE",
    "$PUCSNAME",
    "$PUCSORG",
    "$PUCSORTHOVIEW",
    "$PUCSXDIR",
    "$PUCSYDIR",
    "$QTEXTMODE",
    "$REALWORLDSCALE",
    "$REGENMODE",
    "$REQUIREDVERSIONS",
    "$SHADEDGE",
    "$SHADEDIF",
    "$SHADOWPLANELOCATION",
    "$SHOWHIST",
    "$SKETCHINC",
    "$SKPOLY",
    "$SKTOLERANCE",
    "$SOLIDHIST",
    "$SORTENTS",
    "$SPLFRAME",
    "$SPLINESEGS",
    "$SPLINETYPE",
    "$STEPSIZE",
    "$STEPSPERSEC",
    "$STYLESHEET",
    "$SURFTAB1",
    "$SURFTAB2",
    "$SURFTYPE",
    "$SURFU",
    "$SURFV",
    "$TDCREATE",
    "$TDINDWG",
    "$TDUCREATE",
    "$TDUPDATE",
    "$TDUSRTIMER",
    "$TDUUPDATE",
    "$TEXTQLTY",
    "$TEXTSIZE",
    "$TEXTSTYLE",
    "$THICKNESS",
    "$TILEMODE",
    "$TILEMODELIGHTSYNCH",
    "$TIMEZONE",
    "$TRACEWID",
    "$TREEDEPTH",
    "$UCSBASE",
    "$UCSNAME",
    "$UCSORG",
    "$UCSORTHOVIEW",
    "$UCSXDIR",
    "$UCSYDIR",
    "$USERI1",
    "$USERI2",
    "$USERI3",
    "$USERI4",
    "$USERI5",
    "$USERR1",
    "$USERR2",
    "$USERR3",
    "$USERR4",
    "$USERR5",
    "$USRTIMER",
    "$VERSIONGUID",
    "$VIEWTWIST",
    "$VISRETAIN",
    "$WORLDVIEW",
    "$XCLIPFRAME",
    "$XEDIT",
];
