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
