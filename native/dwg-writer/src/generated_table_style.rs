/// Materialize only the exact generated R2010+ TABLESTYLE payload that the
/// pinned acadrust writer emits from constructor/legacy convenience fields.
/// The source schema guard must first prove this object was absent from the
/// input. Its owned generated style is prepared before the checked baseline;
/// retained raw DXF or an existing modern payload can never enter this path.
///
/// Source: acadrust 0.6.4 object_writer/objects.rs, write_table_style,
/// write_default_modern_table_cell_style, write_default_modern_table_row_styles,
/// write_default_modern_table_row_style and the two text-style resolvers.
pub(crate) fn canonical_generated_table_style(
    document: &acadrust::document::CadDocument,
    source: &acadrust::objects::TableStyle,
) -> Result<acadrust::objects::TableStyle, String> {
    use acadrust::objects::{
        NamedTableCellStyle, RowCellStyle, TableCellBorder, TableCellStyleData, TableContentFormat,
        TableGridFormat, TableStyleFlags,
    };
    use acadrust::types::{Color, Handle};

    if source.modern_style.is_some() || source.raw_dxf_codes.is_some() {
        return Err("Retained TABLESTYLE data cannot use generated canonicalization.".into());
    }
    if !source.modern_overrides.is_empty() {
        return Err("A partial modern TABLESTYLE cannot use generated canonicalization.".into());
    }

    fn is_text_style_handle(document: &acadrust::document::CadDocument, handle: Handle) -> bool {
        !handle.is_null()
            && document
                .text_styles
                .iter()
                .any(|style| style.handle == handle)
    }

    fn resolve_table_text_style(
        document: &acadrust::document::CadDocument,
        handle: Handle,
    ) -> Handle {
        if is_text_style_handle(document, handle) {
            return handle;
        }
        document
            .text_styles
            .get("Standard")
            .map(|style| style.handle)
            .filter(|handle| !handle.is_null())
            .or_else(|| {
                document
                    .text_styles
                    .iter()
                    .map(|style| style.handle)
                    .find(|handle| !handle.is_null())
            })
            .unwrap_or(Handle::NULL)
    }

    fn resolve_table_row_text_style(
        document: &acadrust::document::CadDocument,
        row: &RowCellStyle,
    ) -> Handle {
        row.text_style_handle
            .filter(|handle| is_text_style_handle(document, *handle))
            .or_else(|| {
                // Match the writer exactly: a named row style is selected even
                // if its handle is null; only a missing name uses the fallback.
                document
                    .text_styles
                    .get(&row.text_style_name)
                    .map(|style| style.handle)
            })
            .unwrap_or_else(|| resolve_table_text_style(document, Handle::NULL))
    }

    let mut value = source.clone();
    // TableStyle::effective_flags is crate-private. This is its exact public
    // equivalent, followed by the generated writer's stale-storage-bit mask.
    let mut flags = source.flags;
    flags.set(TableStyleFlags::TITLE_SUPPRESSED, !source.has_title_row());
    flags.set(TableStyleFlags::HEADER_SUPPRESSED, !source.has_header_row());
    let native_flags = flags.bits() & !8i16;
    value.modern_unknown_long1 = native_flags as i32;
    value.flags = TableStyleFlags::from_bits_retain(native_flags);
    value.title_suppressed = value.flags.contains(TableStyleFlags::TITLE_SUPPRESSED);
    value.header_suppressed = value.flags.contains(TableStyleFlags::HEADER_SUPPRESSED);

    // modern_unknown_byte, modern_unknown_long2 and the owned cellstyle handle
    // are cloned unchanged: write_table_style emits those exact source slots.
    value.modern_style = Some(NamedTableCellStyle {
        cell_style: TableCellStyleData {
            style_type: 5,
            data_flags: 1,
            background_color: Color::None,
            content_layout: 1,
            content_format: TableContentFormat {
                value_data_type: 512,
                block_scale: 1.0,
                cell_alignment: 1,
                content_color: Color::ByBlock,
                // This is the fixed base height, independent of the data row.
                text_height: 0.18,
                ..TableContentFormat::default()
            },
            margin_override_flags: 1,
            vertical_margin: source.vertical_margin,
            horizontal_margin: source.horizontal_margin,
            bottom_margin: source.vertical_margin,
            right_margin: source.horizontal_margin,
            horizontal_spacing: 0.18,
            vertical_spacing: 0.18,
            ..TableCellStyleData::default()
        },
        id: 4,
        style_type: 2,
        name: "Table".to_string(),
    });

    let rows = [
        (1, &source.title_row_style, 1, 1, "_TITLE", 0x8000),
        (2, &source.header_row_style, 2, 1, "_HEADER", 0),
        (3, &source.data_row_style, 3, 2, "_DATA", 0),
    ];
    value.modern_overrides = rows
        .into_iter()
        .map(|(key, row, id, style_type, name, merge_flags)| {
            let borders = [
                (1, &row.top_border),
                (2, &row.horizontal_inside_border),
                (4, &row.bottom_border),
                (8, &row.left_border),
                (16, &row.vertical_inside_border),
                (32, &row.right_border),
            ]
            .into_iter()
            .map(|(index_mask, border)| TableGridFormat {
                index_mask,
                border: TableCellBorder {
                    is_invisible: !border.is_invisible,
                    ..border.clone()
                },
                line_type: Handle::NULL,
            })
            .collect();
            (
                key,
                NamedTableCellStyle {
                    cell_style: TableCellStyleData {
                        style_type: 5,
                        data_flags: 1,
                        merge_flags,
                        background_color: if row.fill_enabled {
                            row.fill_color
                        } else {
                            Color::None
                        },
                        content_layout: 1,
                        content_format: TableContentFormat {
                            value_data_type: row.data_type,
                            value_unit_type: row.unit_type,
                            value_format_string: row.format_string.clone(),
                            block_scale: 1.0,
                            cell_alignment: row.alignment as i32,
                            content_color: row.text_color,
                            text_style: resolve_table_row_text_style(document, row),
                            text_height: row.text_height,
                            ..TableContentFormat::default()
                        },
                        borders,
                        ..TableCellStyleData::default()
                    },
                    id,
                    style_type,
                    name: name.to_string(),
                },
            )
        })
        .collect();
    // The modern encoder re-resolves an invalid row handle. The generated
    // legacy path can select a named style with a NULL handle instead; refuse
    // that malformed document rather than changing its resolution on prepare.
    let fallback = resolve_table_text_style(document, Handle::NULL);
    if !fallback.is_null()
        && value
            .modern_overrides
            .iter()
            .any(|(_, style)| style.cell_style.content_format.text_style.is_null())
    {
        return Err("Generated TABLESTYLE names a text style with a NULL handle.".into());
    }
    Ok(value)
}

/// Check the complete legacy representation against the modern native slots
/// before changing the checked baseline. Retained CELLSTYLEMAP formats stay
/// authoritative, and convenience values without an exact native encoding
/// refuse instead of being dropped from the preservation comparison.
pub(crate) fn canonical_retained_legacy_table_style(
    document: &acadrust::document::CadDocument,
    source: &acadrust::objects::TableStyle,
) -> Result<acadrust::objects::TableStyle, String> {
    use acadrust::objects::{CellAlignment, RowCellStyle, TableFlowDirection, TableStyleFlags};
    use acadrust::types::Handle;
    if source.modern_style.is_some() || source.raw_dxf_codes.is_none() {
        return Err("Retained legacy TABLESTYLE requires its original legacy record.".into());
    }
    if !source.description.is_empty()
        || source.version != 0
        || source.flow_direction != TableFlowDirection::Down
        || source.annotative
        || source.title_suppressed != source.flags.contains(TableStyleFlags::TITLE_SUPPRESSED)
        || source.header_suppressed != source.flags.contains(TableStyleFlags::HEADER_SUPPRESSED)
    {
        return Err("Legacy TABLESTYLE description/version/flow/annotation has no exact modern encoding.".into());
    }
    let raw = source.raw_dxf_codes.as_ref().unwrap();
    let subclass = raw.iter().position(|(code, value)| *code == 100 && value == "AcDbTableStyle")
        .ok_or("Legacy TABLESTYLE lacks its original subclass.")?;
    let mut named = false;
    let mut seen = std::collections::BTreeSet::new();
    for (code, value) in &raw[subclass + 1..] {
        if *code == 7 || *code == 1001 { break; }
        if !matches!(*code, 3 | 70 | 71 | 40 | 41 | 280 | 281) {
            return Err("Legacy TABLESTYLE has an unrepresentable header property.".into());
        }
        let key = if *code == 280 && !named { -280 } else { *code };
        if !seen.insert(key) { return Err("Legacy TABLESTYLE duplicates a header property.".into()); }
        if *code == 3 { named = true; }
        if *code == 71 && value.trim().parse::<i16>() != Ok(source.flags.bits()) {
            return Err("Legacy TABLESTYLE has conflicting source flag/suppression values.".into());
        }
        if *code == 70 && value.trim().parse::<i16>() != Ok(0) {
            return Err("Legacy TABLESTYLE source flow has no exact modern encoding.".into());
        }
    }
    for (name, row) in [
        ("_DATA", &source.data_row_style),
        ("_HEADER", &source.header_row_style),
        ("_TITLE", &source.title_row_style),
    ] {
        if !row.fill_enabled && row.fill_color != acadrust::types::Color::Index(7) {
            return Err(format!("Legacy TABLESTYLE {name} row has no exact inactive-fill encoding."));
        }
    }
    let mut generated = source.clone();
    generated.raw_dxf_codes = None;
    generated.modern_overrides.clear();
    let mut prepared = canonical_generated_table_style(document, &generated)?;
    prepared.raw_dxf_codes = source.raw_dxf_codes.clone();
    // Retained flag bits are native data, unlike a constructor's stale bit8.
    prepared.modern_unknown_long1 = source.flags.bits() as i32;
    prepared.flags = source.flags;
    if !source.modern_overrides.is_empty() {
        prepared.modern_overrides = source.modern_overrides.clone();
    }
    if prepared.modern_overrides.len() > 64 {
        return Err("Legacy TABLESTYLE exceeds the native override budget.".into());
    }
    let resolve = |row: &RowCellStyle| -> Result<Handle, String> {
        let named = document.text_styles.get(&row.text_style_name)
            .ok_or("Legacy TABLESTYLE names a missing text style.")?;
        let handle = row.text_style_handle.unwrap_or(named.handle);
        if handle.is_null() || handle != named.handle {
            return Err("Legacy TABLESTYLE has conflicting text-style identity/name.".into());
        }
        Ok(handle)
    };
    for (name, original, mut decoded) in [
        ("_DATA", &source.data_row_style, RowCellStyle::data_row()),
        ("_HEADER", &source.header_row_style, RowCellStyle::header_row()),
        ("_TITLE", &source.title_row_style, RowCellStyle::title_row()),
    ] {
        let matches: Vec<_> = prepared.modern_overrides.iter()
            .filter(|(_, cell)| cell.name == name).collect();
        if matches.len() != 1 {
            return Err("Legacy TABLESTYLE requires one native format for each row.".into());
        }
        let style = &matches[0].1.cell_style;
        let format = &style.content_format;
        if format.text_style != resolve(original)? {
            return Err("Legacy TABLESTYLE native format changed a text-style reference.".into());
        }
        decoded.text_style_name = original.text_style_name.clone();
        decoded.text_style_handle = Some(format.text_style);
        decoded.data_type = format.value_data_type;
        decoded.unit_type = format.value_unit_type;
        decoded.format_string = format.value_format_string.clone();
        decoded.alignment = CellAlignment::from(format.cell_alignment as i16);
        decoded.text_color = format.content_color;
        decoded.text_height = format.text_height;
        decoded.fill_enabled = style.background_color != acadrust::types::Color::None;
        if decoded.fill_enabled { decoded.fill_color = style.background_color; }
        let mut masks = std::collections::BTreeSet::new();
        for grid in &style.borders {
            if !masks.insert(grid.index_mask) {
                return Err("Legacy TABLESTYLE has ambiguous native border formats.".into());
            }
            let border = match grid.index_mask {
                1 => &mut decoded.top_border,
                2 => &mut decoded.horizontal_inside_border,
                4 => &mut decoded.bottom_border,
                8 => &mut decoded.left_border,
                16 => &mut decoded.vertical_inside_border,
                32 => &mut decoded.right_border,
                _ => return Err("Legacy TABLESTYLE has an unrepresentable border mask.".into()),
            };
            *border = grid.border.clone();
            border.is_invisible = !border.is_invisible;
        }
        // Missing grid overrides have the decoder's exact default borders.
        // The complete row equality below still checks all six source edges.
        let mut expected = original.clone();
        expected.text_style_handle = Some(resolve(original)?);
        if decoded != expected {
            return Err(format!("Legacy TABLESTYLE {name} row does not match its complete native format."));
        }
    }
    Ok(prepared)
}
