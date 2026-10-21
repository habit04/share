/** Main-process schema twin of src/io/import-provenance.ts; diagnostics grant no file access. */
'use strict';
const ACTIONS = [
    'dropped',
    'simplified',
    'kept',
    'unsupported'
];
const AUTOSAVE_IMPORT_LIMITS = {
    items: 64,
    types: 128,
    notes: 16,
    text: 512,
    name: 128
};
function cleanImportSourcePath(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}
const count = (n)=>typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const text = (s, max)=>typeof s === 'string' && s.length <= max;
const fallback = ()=>({
        version: 1,
        format: 'DXF',
        counts: [
            {
                type: 'IMPORT_SOURCE',
                dropped: 1,
                simplified: 0,
                kept: 0,
                unsupported: 0
            }
        ],
        items: [],
        omitted: 1,
        notes: [
            'The recovered copy came with incomplete import diagnostics. Its source remains protected; use Save As to a separate file.'
        ]
    });
function cleanPartialImportProvenance(value) {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object') return fallback();
    const v = value;
    if (v.version !== 1 || ![
        'DXF',
        'DWG'
    ].includes(v.format) || !Array.isArray(v.counts) || v.counts.length > AUTOSAVE_IMPORT_LIMITS.types || !Array.isArray(v.items) || v.items.length > AUTOSAVE_IMPORT_LIMITS.items || !Array.isArray(v.notes) || v.notes.length > AUTOSAVE_IMPORT_LIMITS.notes || !count(v.omitted) || v.fontSubstitutions !== undefined && !count(v.fontSubstitutions)) return fallback();
    const counts = [];
    for (const entry of v.counts){
        if (!entry || !text(entry.type, AUTOSAVE_IMPORT_LIMITS.name) || ACTIONS.some((action)=>!count(entry[action]))) return fallback();
        counts.push({
            type: entry.type,
            dropped: entry.dropped,
            simplified: entry.simplified,
            kept: entry.kept,
            unsupported: entry.unsupported
        });
    }
    const items = [];
    for (const item of v.items){
        if (!item || !text(item.type, AUTOSAVE_IMPORT_LIMITS.name) || !ACTIONS.includes(item.action) || !text(item.reason, AUTOSAVE_IMPORT_LIMITS.text) || item.handle !== undefined && !text(item.handle, AUTOSAVE_IMPORT_LIMITS.name) || item.layer !== undefined && !text(item.layer, AUTOSAVE_IMPORT_LIMITS.name) || item.where !== undefined && !text(item.where, AUTOSAVE_IMPORT_LIMITS.text) || item.line !== undefined && !count(item.line)) return fallback();
        items.push({
            type: item.type,
            action: item.action,
            reason: item.reason,
            ...item.handle !== undefined ? {
                handle: item.handle
            } : {},
            ...item.layer !== undefined ? {
                layer: item.layer
            } : {},
            ...item.where !== undefined ? {
                where: item.where
            } : {},
            ...item.line !== undefined ? {
                line: item.line
            } : {}
        });
    }
    if (v.notes.some((note)=>!text(note, AUTOSAVE_IMPORT_LIMITS.text)) || v.recovered !== undefined && (!v.recovered || !count(v.recovered.line) || !text(v.recovered.message, AUTOSAVE_IMPORT_LIMITS.text))) return fallback();
    if (!v.recovered && !counts.some((entry)=>entry.dropped || entry.simplified)) return fallback();
    return {
        version: 1,
        format: v.format,
        counts,
        items,
        omitted: v.omitted,
        notes: [
            ...v.notes
        ],
        ...v.recovered ? {
            recovered: {
                line: v.recovered.line,
                message: v.recovered.message
            }
        } : {},
        ...v.fontSubstitutions !== undefined ? {
            fontSubstitutions: v.fontSubstitutions
        } : {}
    };
}

module.exports = { cleanPartialImportProvenance, cleanImportSourcePath };
