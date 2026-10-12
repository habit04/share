//! Keep controls-first visible geometry and retain fit editing metadata in bounded XDATA.
use acadrust::entities::Spline;
use acadrust::tables::AppId;
use acadrust::types::Vector3;
use acadrust::xdata::{ExtendedDataRecord, XDataValue};
use acadrust::{CadDocument, EntityType};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const APPLICATION: &str = "JCAD_SPLINE_FIT";
const MAX_PACKET_BYTES: usize = 4096;
const CHUNK_BYTES: usize = 240;
const MAX_XDATA_BYTES: usize = 16_000;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Packet {
    schema_version: u32,
    geometry_sha256: String,
    fit_points: Vec<Vector3>,
    begin_tangent: Vector3,
    end_tangent: Vector3,
    fit_tolerance: f64,
    knot_parameterization: i32,
    knot_tolerance: f64,
    control_tolerance: f64,
    dxf_flags: i16,
    dwg_flags1: i32,
    planar: bool,
    linear: bool,
}

fn geometry_hash(spline: &Spline) -> Result<String, String> {
    let geometry = if spline.control_points.is_empty() {
        serde_json::json!({"representation":"fit","degree":spline.degree,"fitPoints":spline.fit_points,"closed":spline.flags.closed})
    } else {
        serde_json::json!({"representation":"control","degree":spline.degree,"controlPoints":spline.control_points,"knots":spline.knots,"weights":spline.weights,"closed":spline.flags.closed,"periodic":spline.flags.periodic,"rational":spline.flags.rational})
    };
    let bytes = serde_json::to_vec(&geometry).map_err(|_| "Cannot fingerprint spline geometry.")?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn capture(spline: &Spline) -> Result<Packet, String> {
    Ok(Packet {
        schema_version: 1,
        geometry_sha256: geometry_hash(spline)?,
        fit_points: spline.fit_points.clone(),
        begin_tangent: spline.begin_tangent,
        end_tangent: spline.end_tangent,
        fit_tolerance: spline.fit_tolerance,
        knot_parameterization: spline.knot_parameterization,
        knot_tolerance: spline.knot_tolerance,
        control_tolerance: spline.control_tolerance,
        dxf_flags: spline.dxf_flags,
        dwg_flags1: spline.dwg_flags1,
        planar: spline.flags.planar,
        linear: spline.flags.linear,
    })
}

fn encode(packet: &Packet) -> Result<ExtendedDataRecord, String> {
    let json = serde_json::to_string(packet).map_err(|_| "Cannot encode spline fit metadata.")?;
    if !json.is_ascii() || json.len() > MAX_PACKET_BYTES {
        return Err(
            "Spline fit metadata exceeds its lossless DWG export budget; save a DXF copy instead."
                .into(),
        );
    }
    let mut record = ExtendedDataRecord::new(APPLICATION);
    for chunk in json.as_bytes().chunks(CHUNK_BYTES) {
        record.add_value(XDataValue::String(
            std::str::from_utf8(chunk).unwrap().to_owned(),
        ));
    }
    Ok(record)
}

fn decode(record: &ExtendedDataRecord) -> Result<Packet, String> {
    let mut json = String::new();
    for value in &record.values {
        let XDataValue::String(chunk) = value else {
            return Err(
                "Conflicting reserved JCAD_SPLINE_FIT metadata; save a DXF copy instead.".into(),
            );
        };
        if !chunk.is_ascii()
            || chunk.len() > CHUNK_BYTES
            || json.len() + chunk.len() > MAX_PACKET_BYTES
        {
            return Err("Invalid or oversized reserved spline fit metadata.".into());
        }
        json.push_str(chunk);
    }
    let packet: Packet = serde_json::from_str(&json)
        .map_err(|_| "Conflicting reserved JCAD_SPLINE_FIT metadata; save a DXF copy instead.")?;
    if packet.schema_version != 1
        || packet.geometry_sha256.len() != 64
        || !packet
            .geometry_sha256
            .chars()
            .all(|c| c.is_ascii_hexdigit())
    {
        return Err("Invalid reserved spline fit metadata.".into());
    }
    Ok(packet)
}

fn restore(spline: &mut Spline, packet: &Packet) {
    spline.fit_points = packet.fit_points.clone();
    spline.begin_tangent = packet.begin_tangent;
    spline.end_tangent = packet.end_tangent;
    spline.fit_tolerance = packet.fit_tolerance;
    spline.knot_parameterization = packet.knot_parameterization;
    spline.knot_tolerance = packet.knot_tolerance;
    spline.control_tolerance = packet.control_tolerance;
    spline.dxf_flags = packet.dxf_flags;
    spline.dwg_flags1 = packet.dwg_flags1;
    spline.flags.planar = packet.planar;
    spline.flags.linear = packet.linear;
}

fn xdata_size(spline: &Spline) -> usize {
    spline
        .common
        .extended_data
        .records()
        .iter()
        .map(|record| {
            16 + record.application_name.len()
                + record
                    .values
                    .iter()
                    .map(|value| match value {
                        XDataValue::String(s)
                        | XDataValue::LayerName(s)
                        | XDataValue::ControlString(s) => 8 + s.encode_utf16().count() * 2,
                        XDataValue::BinaryData(bytes) => bytes.len() + 8,
                        XDataValue::Point3D(_)
                        | XDataValue::Position3D(_)
                        | XDataValue::Displacement3D(_)
                        | XDataValue::Direction3D(_) => 32,
                        _ => 16,
                    })
                    .sum::<usize>()
        })
        .sum()
}

pub fn prepare(doc: &mut CadDocument) -> Result<(), String> {
    let mut needed = false;
    for entity in doc.entities_mut() {
        let EntityType::Spline(spline) = entity else {
            continue;
        };
        needed = true;
        let reserved = spline
            .common
            .extended_data
            .records()
            .iter()
            .filter(|record| record.application_name.eq_ignore_ascii_case(APPLICATION))
            .collect::<Vec<_>>();
        if reserved.len() > 1 {
            return Err(
                "Conflicting reserved JCAD_SPLINE_FIT metadata; save a DXF copy instead.".into(),
            );
        }
        let existing_name = reserved
            .first()
            .map(|record| record.application_name.clone());
        let packet = if let Some(record) = reserved.first() {
            let packet = decode(record)?;
            if packet.geometry_sha256 != geometry_hash(spline)?
                || (!spline.fit_points.is_empty() && spline.fit_points != packet.fit_points)
            {
                return Err("Spline geometry conflicts with reserved JCAD_SPLINE_FIT metadata; save a DXF copy instead.".into());
            }
            packet
        } else {
            capture(spline)?
        };
        restore(spline, &packet);
        let record = encode(&packet)?;
        if let Some(name) = existing_name {
            spline.common.extended_data.remove_record(&name);
        }
        spline.common.extended_data.add_record(record);
        if xdata_size(spline) > MAX_XDATA_BYTES {
            return Err(
                "Spline application metadata exceeds the DWG XDATA limit; save a DXF copy instead."
                    .into(),
            );
        }
        // Custom knots select the control-point scenario, preserving the visible curve JCad
        // renders when both representations are present. Auxiliary fit data stays in XDATA.
        if !spline.control_points.is_empty() {
            spline.knot_parameterization = 15;
        }
    }
    if needed && doc.app_ids.get(APPLICATION).is_none() {
        doc.app_ids
            .add(AppId::new(APPLICATION))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn verify_and_restore(doc: &mut CadDocument) -> Result<(), String> {
    for entity in doc.entities_mut() {
        let EntityType::Spline(spline) = entity else {
            continue;
        };
        let record = spline
            .common
            .extended_data
            .get_record(APPLICATION)
            .ok_or("DWG reopening lost reserved spline fit metadata.")?;
        let packet = decode(record)?;
        // Check actual native curve data before restoring any auxiliary editing metadata.
        if packet.geometry_sha256 != geometry_hash(spline)? {
            return Err(
                "DWG reopening changed spline control geometry or fit representation.".into(),
            );
        }
        restore(spline, &packet);
        if !spline.control_points.is_empty() {
            spline.knot_parameterization = 15;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn spline() -> Spline {
        let mut spline = Spline::from_control_points(
            2,
            vec![
                Vector3::new(0.0, 0.0, 0.0),
                Vector3::new(1.0, 2.0, 0.0),
                Vector3::new(3.0, 0.0, 0.0),
            ],
        );
        spline.fit_points = vec![Vector3::new(0.0, 0.0, 0.0), Vector3::new(3.0, 0.0, 0.0)];
        spline.flags.planar = true;
        spline
    }
    #[test]
    fn chunked_packet_keeps_fit_values_and_curve_fingerprint() {
        let source = spline();
        let packet = capture(&source).unwrap();
        let record = encode(&packet).unwrap();
        assert!(record
            .values
            .iter()
            .all(|value| matches!(value,XDataValue::String(s) if s.len() <= CHUNK_BYTES)));
        let decoded = decode(&record).unwrap();
        assert_eq!(decoded.fit_points, source.fit_points);
        assert_eq!(decoded.geometry_sha256, geometry_hash(&source).unwrap());
        let mut changed = source.clone();
        changed.control_points[1].x += 1.0;
        assert_ne!(decoded.geometry_sha256, geometry_hash(&changed).unwrap());
    }
    #[test]
    fn oversized_or_conflicting_packets_are_refused() {
        let mut source = spline();
        source.fit_points = vec![Vector3::new(1.123456789, 2.987654321, 0.0); 1000];
        assert!(encode(&capture(&source).unwrap()).is_err());
        let mut record = ExtendedDataRecord::new(APPLICATION);
        record.add_value(XDataValue::String("existing different schema".into()));
        assert!(decode(&record).is_err());
    }
    #[test]
    fn source_packet_conflicts_refuse_and_controls_are_selected() {
        let mut doc = CadDocument::new();
        doc.add_entity(EntityType::Spline(spline())).unwrap();
        prepare(&mut doc).unwrap();
        let EntityType::Spline(spline) = doc.entities().next().unwrap() else {
            panic!()
        };
        assert_eq!(spline.knot_parameterization, 15);
        assert!(spline
            .common
            .extended_data
            .get_record(APPLICATION)
            .is_some());
        let EntityType::Spline(spline) = doc.entities_mut().next().unwrap() else {
            panic!()
        };
        spline.control_points[1].x += 1.0;
        assert!(prepare(&mut doc).is_err());
    }
    #[test]
    fn matching_existing_packet_is_reused_without_duplicate_app_records() {
        let mut doc = CadDocument::new();
        doc.add_entity(EntityType::Spline(spline())).unwrap();
        prepare(&mut doc).unwrap();
        prepare(&mut doc).unwrap();
        let EntityType::Spline(spline) = doc.entities().next().unwrap() else {
            panic!()
        };
        assert_eq!(
            spline
                .common
                .extended_data
                .records()
                .iter()
                .filter(|record| record.application_name.eq_ignore_ascii_case(APPLICATION))
                .count(),
            1
        );
        assert_eq!(spline.fit_points.len(), 2);
    }
}
