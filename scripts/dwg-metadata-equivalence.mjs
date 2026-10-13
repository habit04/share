/** Independent raw-DXF postflight. No writer DTO or parser snapshot participates in this check. */
const MAX_BYTES = 32 * 1024 * 1024, MAX_PAIRS = 2_000_000, MAX_RECORDS = 250_000, MAX_VALUE = 1024 * 1024;
const dictionaries = new Set(['DICTIONARY', 'ACDBDICTIONARYWDFLT']);
// These variables describe serialization, derived extents or per-save clocks, not retained CAD data.
const volatileHeader = new Set(['$ACADVER', '$ACADMAINTVER', '$DWGCODEPAGE', '$HANDSEED', '$VERSIONGUID', '$EXTMIN', '$EXTMAX', '$PEXTMIN', '$PEXTMAX', '$TDUPDATE', '$TDUUPDATE', '$TDINDWG', '$TDUSRTIMER']);
const nameHeader = new Map([['$CLAYER', ['LAYER', 8]], ['$CELTYPE', ['LTYPE', 6]], ['$TEXTSTYLE', ['STYLE', 7]], ['$DIMSTYLE', ['DIMSTYLE', 2]], ['$DIMTXSTY', ['STYLE', 7]], ['$DIMBLK', ['BLOCK_RECORD', 1]], ['$DIMBLK1', ['BLOCK_RECORD', 1]], ['$DIMBLK2', ['BLOCK_RECORD', 1]], ['$CANNOSCALE', ['SCALE', 2]], ['$CMLSTYLE', ['MLINESTYLE', 2]]]);
/** @typedef {{ code:number, value:string }} Pair */
/** @typedef {{ type:string, section:string, groups:Pair[], handle?:string, aliases:Set<string> }} RecordData */
/** @typedef {{ records:RecordData[], handles:Map<string,RecordData>, aliases:Map<string,RecordData>, header:Map<string,Pair[]> }} Parsed */
/** @typedef {{handle:string,type:string,dxfType:string}} InventoryObject */

export class DwgMetadataEquivalenceError extends Error {
  constructor(message) { super(`DWG metadata verification failed: ${message}. The destination was not changed.`); this.name = 'DwgMetadataEquivalenceError'; }
}
const fail = message => { throw new DwgMetadataEquivalenceError(message); };
const short = value => { const text = JSON.stringify(value) ?? String(value); return text.length > 180 ? text.slice(0, 177) + '...' : text; };
const handle = value => {
  const raw = value.trim();
  if (!/^[0-9A-Fa-f]{1,16}$/.test(raw)) fail('an object identity is not a bounded hexadecimal handle');
  return BigInt('0x' + raw).toString(16).toUpperCase();
};
const unicode = value => value.replace(/\\U\+([0-9a-f]{4})/gi, (whole, hex) => { const code = parseInt(hex, 16); return code < 32 || code === 127 ? whole : String.fromCharCode(code); });
const identifier = value => unicode(value.trim()).toUpperCase();
const valueOf = (record, code) => record.groups.find(pair => pair.code === code)?.value.trim() ?? '';
const pointer = code => code >= 330 && code <= 369 || code >= 390 && code <= 399 || code === 480 || code === 481 || code === 1005;
const integer = code => code >= 60 && code <= 99 || code >= 160 && code <= 179 || code >= 270 && code <= 299 || code >= 370 && code <= 389 || code >= 400 && code <= 409 || code >= 420 && code <= 429 || code >= 440 && code <= 459 || code >= 1060 && code <= 1071;
const real = code => code >= 10 && code <= 59 || code >= 110 && code <= 149 || code >= 210 && code <= 239 || code >= 460 && code <= 469 || code >= 1010 && code <= 1059;

/** @param {string} text @returns {Parsed} */
function parse(text) {
  if (typeof text !== 'string' || text.length > MAX_BYTES) fail('the raw metadata projection exceeds its 32 MiB budget');
  let bytes = 0, lineLength = 0, lines = 1;
  for (const character of text) {
    const code = character.codePointAt(0);
    const size = code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
    bytes += size;
    if (bytes > MAX_BYTES) fail('the raw metadata projection exceeds its 32 MiB UTF-8 budget');
    if (character === '\0') fail('the raw metadata projection contains a null byte');
    if (character === '\n' || character === '\r') { lineLength = 0; if (++lines > 4 * MAX_PAIRS + 4) fail('the raw metadata projection exceeds its line budget'); }
    else if ((lineLength += size) > MAX_VALUE) fail('a raw metadata value exceeds its 1 MiB UTF-8 budget');
  }
  const raw = text.split(/\r\n|\n|\r/); while (raw.at(-1) === '') raw.pop();
  if (raw.length % 2 || raw.length / 2 > MAX_PAIRS) fail('the raw metadata projection has incomplete or excessive group pairs');
  /** @type {RecordData[]} */ const records = [];
  /** @type {Map<string,Pair[]>} */ const header = new Map();
  let section = '', current, variable, closed = false;
  for (let index = 0; index < raw.length; index += 2) {
    const number = raw[index].trim(), code = Number(number), value = raw[index + 1];
    if (!/^\d+$/.test(number) || !Number.isInteger(code) || code > 1071) fail(`invalid group code at line ${index + 1}`);
    if (code === 0) {
      const type = identifier(value);
      current = undefined; variable = undefined;
      if (type === 'SECTION') {
        if (section || raw[index + 2]?.trim() !== '2') fail('invalid section framing');
        section = identifier(raw[index + 3] ?? ''); index += 2;
      } else if (type === 'ENDSEC') { if (!section) fail('an unmatched ENDSEC was emitted'); section = ''; }
      else if (type === 'EOF') { if (section || index !== raw.length - 2) fail('invalid EOF framing'); closed = true; }
      else if (type !== 'ENDTAB') {
        if (!section) fail('an object was emitted outside a section');
        current = { type, section, groups: [], aliases: new Set() }; records.push(current);
        if (records.length > MAX_RECORDS) fail('the raw metadata projection exceeds its record budget');
      }
    } else if (section === 'HEADER') {
      if (code === 9) { variable = value.trim().toUpperCase(); if (header.has(variable)) fail(`duplicate HEADER ${variable}`); header.set(variable, []); }
      else if (variable) header.get(variable).push({ code, value });
    } else if (current) current.groups.push({ code, value });
  }
  if (!closed) fail('the raw metadata projection is incomplete');
  /** @type {Map<string,RecordData>} */ const handles = new Map();
  for (const record of records) {
    const id = valueOf(record, record.type === 'DIMSTYLE' ? 105 : 5);
    if (id) {
      record.handle = handle(id);
      if (record.handle === '0' || handles.has(record.handle)) fail(`duplicate or null ${record.type} identity ${record.handle}`);
      handles.set(record.handle, record);
    }
    if (record.section === 'OBJECTS' && !record.handle) fail(`OBJECTS ${record.type} has no source identity`);
  }
  /** @type {Map<string,RecordData>} */ const aliases = new Map();
  const result = { records, handles, aliases, header };
  assignAliases(result); return result;
}

/** @param {Parsed} data */
function assignAliases(data) {
  let labelBytes = 0;
  const assign = (record, alias) => {
    if (alias.length > 65536 || (labelBytes += alias.length) > MAX_BYTES) fail('logical metadata identities exceed the allocation budget');
    const existing = data.aliases.get(alias);
    if (existing && existing !== record) fail(`ambiguous logical metadata identity ${short(alias)}`);
    if (!record.aliases.has(alias)) { record.aliases.add(alias); data.aliases.set(alias, record); return true; }
    return false;
  };
  let table = ''; const viewportSlots = new Map();
  for (const record of data.records) {
    if (record.section === 'CLASSES' && record.type === 'CLASS') {
      const name = identifier(valueOf(record, 1)); if (!name) fail('a CLASS definition has no proven DXF class name'); assign(record, `class:${name}`);
    } else if (record.section === 'TABLES') {
      if (record.type === 'TABLE') { table = identifier(valueOf(record, 2)); assign(record, `table-control:${table}`); }
      else {
        let alias = `table:${table}:${identifier(valueOf(record, 2))}`;
        // Tiled VPORT arrangements may contain several *Active records. Their
        // ordered cells are a defined table structure, not duplicate symbols.
        if (record.type === 'VPORT') { const slot = viewportSlots.get(alias) ?? 0; viewportSlots.set(alias, slot + 1); alias += `:${slot}`; }
        assign(record, alias);
      }
    } else if (record.type === 'BLOCK') assign(record, `block:${identifier(valueOf(record, 2))}`);
    else if (record.type === 'LAYOUT') {
      const marker = record.groups.findIndex(pair => pair.code === 100 && pair.value.trim() === 'AcDbLayout');
      const name = record.groups.slice(marker + 1).find(pair => pair.code === 1)?.value;
      if (name !== undefined) assign(record, `layout:${identifier(name)}`);
    } else if (['ENTITIES', 'BLOCKS'].includes(record.section) && record.handle && record.type !== 'ENDBLK') assign(record, `entity:${record.type}:${record.handle}`);
  }
  const roots = data.records.filter(record => record.section === 'OBJECTS' && dictionaries.has(record.type) && commonOwner(record) === '0');
  if (roots.length !== 1 && data.records.some(record => record.section === 'OBJECTS')) fail('the native named-object dictionary has no unique root');
  if (roots.length) assign(roots[0], 'dictionary:[]');
  // Known ownership slots create aliases; no arbitrary string or binary payload is searched.
  const queue = data.records.filter(record => record.aliases.size), visited = new Set();
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const record = queue[cursor];
    for (const base of record.aliases) {
      const key = `${record.handle ?? record.type}:${base}`;
      if (visited.has(key)) continue; visited.add(key);
      if (visited.size > MAX_RECORDS * 4) fail('logical metadata ownership exceeds its work budget');
      let depth = 0, fieldChild = 0;
      for (let index = 0; index < record.groups.length; index++) {
        const pair = record.groups[index];
        if (pair.code === 102) { depth = pair.value.trim() === '}' ? 0 : pair.value.trim() === '{ACAD_XDICTIONARY' ? 1 : 2; continue; }
        let suffix;
        if (depth === 1 && pair.code === 360) suffix = '/extension';
        else if (dictionaries.has(record.type) && pair.code === 3 && [350, 360].includes(record.groups[index + 1]?.code)) suffix = '/key:' + JSON.stringify(pair.value);
        else if (!depth && record.type === 'FIELD' && pair.code === 360) suffix = '/field-child:' + fieldChild++;
        if (!suffix) continue;
        const raw = pair.code === 3 ? record.groups[index + 1].value : pair.value, id = handle(raw);
        if (id === '0') continue;
        const child = data.handles.get(id); if (!child) fail(`${record.type}(${record.handle}) has an unresolved owned reference ${id}`);
        const alias = base + suffix;
        if (alias.split('/').length > 65) fail('logical metadata ownership exceeds its depth budget');
        if (assign(child, alias)) queue.push(child);
      }
    }
  }
}
function commonOwner(record) {
  let bracket = 0;
  for (const pair of record.groups) {
    if (pair.code === 102) { bracket = pair.value.trim() === '}' ? 0 : bracket + 1; continue; }
    if (!bracket && pair.code === 100) break;
    if (!bracket && pair.code === 330) return handle(pair.value);
  }
  return undefined;
}

/** @param {Parsed} source @param {Parsed} target */
function recordMatches(source, target) {
  /** @type {Map<RecordData,RecordData>} */ const matches = new Map();
  const used = new Set();
  for (const record of source.records) {
    const candidates = new Set([...record.aliases].flatMap(alias => target.aliases.has(alias) ? [target.aliases.get(alias)] : []));
    if (candidates.size > 1) fail(`${record.type}(${record.handle}) has conflicting target aliases`);
    const matched = candidates.size ? [...candidates][0] : !record.aliases.size && record.handle && target.handles.get(record.handle);
    if (!matched) continue;
    if (matched.type !== record.type || matched.section !== record.section || used.has(matched)) fail(`${record.type}(${record.handle}) changed class or aliases another source object`);
    matches.set(record, matched); used.add(matched);
  }
  return matches;
}

function entityMetadata(record) {
  const pairs = []; let depth = 0, xdata = false;
  for (const pair of record.groups) {
    if (pair.code === 102) { depth += pair.value.trim().startsWith('{') ? 1 : pair.value.trim() === '}' ? -1 : 0; pairs.push(pair); continue; }
    if (pair.code === 1001) xdata = true;
    if (depth || xdata) pairs.push(pair);
  }
  return pairs;
}

function normalizePairs(record, pairs) {
  const result = [], chunks = record.type === 'FIELD' ? [[2, 3], [301, 9]] : [], seen = new Set(), combined = new Map();
  for (const chunk of chunks) combined.set(chunk[0], unicode(pairs.filter(pair => chunk.includes(pair.code)).map(pair => pair.value).join('')));
  let identity = false, subclass = '';
  for (const pair of pairs) {
    if (!identity && record.handle && pair.code === (record.type === 'DIMSTYLE' ? 105 : 5)) { identity = true; continue; }
    if (record.type === 'CLASS' && pair.code === 91) continue;
    if (pair.code === 100) subclass = pair.value.trim();
    const chunk = chunks.find(codes => codes.includes(pair.code));
    if (chunk) {
      if (!seen.has(chunk[0])) result.push({ code: chunk[0], value: combined.get(chunk[0]) });
      seen.add(chunk[0]); continue;
    }
    const named = record.type === 'CLASS' && [1, 2].includes(pair.code) || ['VIEW', 'VPORT'].includes(record.type) && pair.code === 2 || record.type === 'SCALE' && pair.code === 300 || record.type === 'MATERIAL' && pair.code === 1 || record.type === 'LAYOUT' && subclass === 'AcDbLayout' && pair.code === 1;
    result.push(named ? { code: pair.code, value: unicode(pair.value) } : pair);
  }
  // R2004+ PlotSettings stores these fields even when an AC1015 input omitted
  // them. Only the documented defaults are supplied; actual nondefaults remain
  // visible to the comparison. The same group codes in AcDbLayout are unrelated.
  if (record.type === 'LAYOUT' || record.type === 'PLOTSETTINGS') {
    const start = result.findIndex(pair => pair.code === 100 && pair.value.trim() === 'AcDbPlotSettings');
    if (start >= 0) {
      let end = result.findIndex((pair, index) => index > start && pair.code === 100); if (end < 0) end = result.length;
      const defaults = new Map([[76, '0'], [77, '0'], [78, '300'], [333, '0']]);
      const stored = new Map(), retained = [];
      for (const pair of result.slice(start + 1, end)) {
        if (defaults.has(pair.code)) { if (stored.has(pair.code)) fail(`${record.type}(${record.handle}) has duplicated PlotSettings group${pair.code}`); stored.set(pair.code, pair); }
        else retained.push(pair);
      }
      result.splice(start + 1, end - start - 1, ...retained, ...[...defaults].map(([code, value]) => stored.get(code) ?? { code, value }));
    }
  }
  if (record.type === 'LAYOUT') {
    const start = result.findIndex(pair => pair.code === 100 && pair.value.trim() === 'AcDbLayout');
    if (start >= 0) {
      let end = result.findIndex((pair, index) => index > start && (pair.code === 100 || pair.code === 1001)); if (end < 0) end = result.length;
      const body = result.slice(start + 1, end), viewport = body.filter(pair => pair.code === 331);
      if (viewport.length > 1) fail(`LAYOUT(${record.handle}) has duplicated active viewport references`);
      // The typed native FIELD_HANDLE0(active_viewport,331) omits a null reference.
      // Only this optional slot gets its documented null default; nonnull links remain exact.
      result.splice(start + 1, end - start - 1, ...body.filter(pair => pair.code !== 331), viewport[0] ?? { code: 331, value: '0' });
    }
  }
  if (record.type === 'VIEW') {
    const start = result.findIndex(pair => pair.code === 100 && pair.value.trim() === 'AcDbViewTableRecord');
    if (start >= 0) {
      let end = result.findIndex((pair, index) => index > start && (pair.code === 100 || pair.code === 1001)); if (end < 0) end = result.length;
      const core = new Set([2, 70, 40, 10, 20, 41, 11, 21, 31, 12, 22, 32, 42, 43, 44, 50, 71]);
      const groups = result.slice(start + 1, end), scalar = groups.filter(pair => core.has(pair.code)), other = groups.filter(pair => !core.has(pair.code));
      // Native DWG projection prints twist50 before lens42; ordinary DXF writers
      // often print it after clip44. These are independent scalar properties.
      // Stable sorting preserves repeated-value order and every unknown group.
      scalar.sort((a, b) => a.code - b.code); result.splice(start + 1, end - start - 1, ...scalar, ...other);
    }
  }
  return result;
}

/** @param {Parsed} parsed @param {readonly InventoryObject[]} inventory */
function verifyInventory(parsed, inventory) {
  if (!Array.isArray(inventory) || inventory.length > 100000) fail('the independent target inventory is invalid or exceeds its budget');
  const seen = new Set();
  for (const object of inventory) {
    if (!object || typeof object.handle !== 'string' || typeof object.type !== 'string' || typeof object.dxfType !== 'string' || object.type.length > 128 || object.dxfType.length > 128) fail('the independent target inventory has an invalid object');
    const id = handle(object.handle);
    if (id === '0' || seen.has(id)) fail('the independent target inventory has duplicate or null handles'); seen.add(id);
    const record = parsed.handles.get(id), nativeType = object.dxfType.toUpperCase();
    const expected = ({ BLOCK_HEADER: 'BLOCK_RECORD', MINSERT: 'INSERT' }[nativeType] ?? nativeType).replace(/^ACDB/, '');
    if (record?.type.replace(/^ACDB/, '') === expected) continue;
    const tables = [object.type, object.dxfType].map(type => type.toUpperCase() === 'BLOCK_CONTROL' ? 'BLOCK_RECORD' : type.toUpperCase().replace(/_CONTROL$/, ''));
    if (record?.type === 'TABLE' && tables.includes(identifier(valueOf(record, 2)))) continue;
    fail(`TARGET:${object.type}(${id}) is absent or changed class in the independently decoded raw projection`);
  }
}

function dictionaryPayload(record, ignored = new Set()) {
  const groups = [], entries = new Map();
  for (let index = 0; index < record.groups.length; index++) {
    const pair = record.groups[index];
    if (pair.code === 3 && [350, 360].includes(record.groups[index + 1]?.code)) {
      if (entries.has(pair.value)) fail(`${record.type}(${record.handle}) has duplicate dictionary keys`);
      const ref = record.groups[++index]; if (!ignored.has(pair.value)) entries.set(pair.value, ref);
    } else groups.push(pair);
  }
  for (const [key, ref] of [...entries].sort(([a], [b]) => a.localeCompare(b))) groups.push({ code: 3, value: key }, ref);
  return groups;
}

function dictionaryEntries(record, parsed) {
  const entries = new Map();
  if (!record || !dictionaries.has(record.type)) fail('the annotation-variable registry is not a typed dictionary');
  for (let index = 0; index < record.groups.length; index++) {
    const pair = record.groups[index];
    if (pair.code !== 3) continue;
    const ref = record.groups[++index];
    if (!ref || ![350, 360].includes(ref.code) || entries.has(pair.value)) fail(`${record.type}(${record.handle}) has malformed dictionary entries`);
    const object = parsed.handles.get(handle(ref.value)); if (!object) fail(`${record.type}(${record.handle}) has an unresolved registry entry`);
    entries.set(pair.value, object);
  }
  return entries;
}

function introducedRecord(record, owner, subclass, payload, fixed = new Map()) {
  if (commonOwner(record) !== owner.handle) fail(`${record.type}(${record.handle}) has a disconnected synthesized owner`);
  let marker = false, bracket = false;
  const counts = new Map();
  for (const pair of record.groups) {
    if (pair.code === 5) continue;
    if (pair.code === 102) {
      const value = pair.value.trim();
      if (value === '{ACAD_REACTORS' && !bracket && !marker) bracket = true;
      else if (value === '}' && bracket) bracket = false;
      else fail(`${record.type}(${record.handle}) has unrecognized synthesized common metadata`);
    } else if (!marker && pair.code === 330) { if (handle(pair.value) !== owner.handle) fail(`${record.type}(${record.handle}) has a disconnected synthesized reactor/owner`); }
    else if (pair.code === 100 && !bracket && !marker && pair.value.trim() === subclass) marker = true;
    else if (marker && payload.has(pair.code)) {
      counts.set(pair.code, (counts.get(pair.code) ?? 0) + 1);
      if (fixed.has(pair.code) && pair.value.trim() !== fixed.get(pair.code)) fail(`${record.type}(${record.handle}) has an unsupported synthesized group${pair.code}`);
    } else fail(`${record.type}(${record.handle}) has an unrecognized synthesized property group${pair.code}`);
  }
  if (!marker || bracket) fail(`${record.type}(${record.handle}) has incomplete synthesized subclass framing`);
  for (const [code, count] of counts) if (count > 1 && code !== 3 && code !== 350 && code !== 360) fail(`${record.type}(${record.handle}) has duplicated synthesized group${code}`);
}

/** CANNOSCALE/ANNOALLVISIBLE are DXF-facing names for a typed named-object variable registry. */
function annotationEncoding(source, target, matches) {
  const derived = new Map(), ignored = new Map(), names = ['$CANNOSCALE', '$ANNOALLVISIBLE'].filter(name => source.header.has(name));
  if (!names.length) return { derived, ignored };
  const root = target.aliases.get('dictionary:[]');
  const entries = dictionaryEntries(root, target), variables = entries.get('AcDbVariableDictionary');
  if (!variables) fail('SOURCE:HEADER annotation variables have no target AcDbVariableDictionary');
  if (commonOwner(variables) !== root.handle) fail('the target annotation-variable dictionary is disconnected from the named-object root');
  const vars = dictionaryEntries(variables, target), scales = entries.get('ACAD_SCALELIST');
  let scaleEntries;
  for (const name of names) {
    const key = name.slice(1), object = vars.get(key);
    if (!object || object.type !== 'DICTIONARYVAR' || commonOwner(object) !== variables.handle) fail(`SOURCE:HEADER.${name} has no owned DICTIONARYVAR value`);
    const values = object.groups.filter(pair => pair.code === 1);
    if (values.length !== 1) fail(`SOURCE:HEADER.${name} has an ambiguous DICTIONARYVAR value`);
    if (name === '$CANNOSCALE') {
      scaleEntries ??= dictionaryEntries(scales, target);
      if (commonOwner(scales) !== root.handle) fail('the target annotation-scale registry is disconnected from the named-object root');
      const candidates = [...scaleEntries.values()].filter(record => record.type === 'SCALE' && identifier(valueOf(record, 300)) === identifier(values[0].value));
      if (candidates.length !== 1 || commonOwner(candidates[0]) !== scales.handle) fail('SOURCE:HEADER.$CANNOSCALE has no unique owned matching SCALE');
      derived.set(name, [{ code: 2, value: values[0].value }]);
    } else {
      if (!/^[01]$/.test(values[0].value.trim())) fail('SOURCE:HEADER.$ANNOALLVISIBLE has invalid DICTIONARYVAR boolean storage');
      derived.set(name, [{ code: 70, value: values[0].value }]);
    }
    if (![...matches.values()].includes(object)) introducedRecord(object, variables, 'DictionaryVariables', new Set([280, 1]), new Map([[280, '0']]));
  }
  const sourceRoot = source.aliases.get('dictionary:[]'), originalRootEntries = sourceRoot ? dictionaryEntries(sourceRoot, source) : new Map();
  const originalVars = originalRootEntries.get('AcDbVariableDictionary'), originalVarEntries = originalVars ? dictionaryEntries(originalVars, source) : new Map();
  const remove = (record, key) => { if (!ignored.has(record)) ignored.set(record, new Set()); ignored.get(record).add(key); };
  if (!originalVars) {
    introducedRecord(variables, root, 'AcDbDictionary', new Set([280, 281, 3, 350, 360]));
    for (const key of vars.keys()) if (!names.includes('$' + key)) fail('the synthesized annotation-variable dictionary contains unrelated properties');
    remove(root, 'AcDbVariableDictionary');
  } else for (const name of names) if (!originalVarEntries.has(name.slice(1))) remove(variables, name.slice(1));
  if (scaleEntries) {
    const originalScales = originalRootEntries.get('ACAD_SCALELIST'), originalScaleEntries = originalScales ? dictionaryEntries(originalScales, source) : new Map();
    for (const [key, object] of scaleEntries) {
      if (originalScaleEntries.has(key)) continue;
      if (object.type !== 'SCALE' || identifier(valueOf(object, 300)) !== identifier(derived.get('$CANNOSCALE')[0].value)) fail('the synthesized annotation-scale registry contains an unrelated SCALE');
      introducedRecord(object, scales, 'AcDbScale', new Set([70, 300, 140, 141, 290]), new Map([[70, '0'], [290, '0']]));
      const sourceName = headerName('$CANNOSCALE', source.header.get('$CANNOSCALE'), source), ratio = /^([+]?(?:\d+(?:\.\d*)?|\.\d+)):([+]?(?:\d+(?:\.\d*)?|\.\d+))$/.exec(sourceName);
      const paper = Number(valueOf(object, 140)), drawing = Number(valueOf(object, 141));
      if (!ratio || !Number.isFinite(paper) || !Number.isFinite(drawing) || paper <= 0 || drawing <= 0 || Math.abs(paper / drawing - Number(ratio[1]) / Number(ratio[2])) > 8 * Number.EPSILON * Math.max(1, paper / drawing)) fail('the synthesized SCALE does not prove the source numeric annotation ratio');
      remove(scales, key);
    }
    if (!originalScales) { introducedRecord(scales, root, 'AcDbDictionary', new Set([280, 281, 3, 350, 360])); remove(root, 'ACAD_SCALELIST'); }
  }
  return { derived, ignored };
}

function sameValue(code, a, b, sourceRecord, source, target, matches, context) {
  if (pointer(code)) {
    const sourceHandle = handle(a), targetHandle = handle(b);
    if (sourceHandle === '0' || targetHandle === '0') { if (sourceHandle !== targetHandle) fail(`${context} reference changed (${sourceHandle} -> ${targetHandle})`); return; }
    const original = source.handles.get(sourceHandle), actual = target.handles.get(targetHandle);
    if (!original || !actual || matches.get(original) !== actual) fail(`${context} reference changed or lost its target (${sourceHandle} -> ${targetHandle})`);
  } else if (code >= 320 && code <= 329) { if (handle(a) !== handle(b)) fail(`${context} arbitrary handle changed`); }
  else if (code >= 310 && code <= 319 || code === 1004) {
    if (!/^(?:[0-9a-f]{2})*$/i.test(a.trim()) || !/^(?:[0-9a-f]{2})*$/i.test(b.trim()) || a.trim().toUpperCase() !== b.trim().toUpperCase()) fail(`${context} binary bytes changed`);
  } else if (integer(code)) {
    if (!/^[+-]?\d{1,20}$/.test(a.trim()) || !/^[+-]?\d{1,20}$/.test(b.trim())) fail(`${context} has invalid bounded integer storage`);
    const first = BigInt(a.trim()), second = BigInt(b.trim());
    if (sourceRecord.type === 'DBCOLOR' && code === 420) {
      if (first < -0x80000000n || first > 0xffffffffn || second < -0x80000000n || second > 0xffffffffn) fail(`${context} has invalid 32-bit color storage`);
      const x = first & 0xffffffffn, y = second & 0xffffffffn, rgb = [0n, 0xc2n].includes(x >> 24n) && [0n, 0xc2n].includes(y >> 24n);
      if ((rgb ? x & 0xffffffn : x) !== (rgb ? y & 0xffffffn : y)) fail(`${context} color value/method changed`);
    } else if (first !== second) fail(`${context} changed (${short(a.trim())} -> ${short(b.trim())})`);
  } else if (real(code)) {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(a.trim()) || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(b.trim())) fail(`${context} has invalid real-number storage`);
    const first = Number(a), second = Number(b);
    if (!Number.isFinite(first) || !Number.isFinite(second) || Math.abs(first - second) > 8 * Number.EPSILON * Math.max(1, Math.abs(first), Math.abs(second))) fail(`${context} changed (${short(a)} -> ${short(b)})`);
  } else {
    // XRECORD/application strings are deliberately opaque, even when they look like DXF escapes.
    const decoded = sourceRecord.type === 'FIELD' && [1, 2, 3, 9, 301].includes(code);
    if ((decoded ? unicode(a) : a) !== (decoded ? unicode(b) : b)) fail(`${context} changed (${short(a)} -> ${short(b)})`);
  }
}

function comparePairs(record, actual, sourcePairs, targetPairs, source, target, matches, label) {
  const first = normalizePairs(record, sourcePairs), second = normalizePairs(actual, targetPairs);
  if (first.length !== second.length) fail(`${label} group count changed (${first.length} -> ${second.length})`);
  for (let index = 0; index < first.length; index++) {
    const a = first[index], b = second[index], context = `${label}.group${a.code}[${index}]`;
    if (a.code !== b.code) fail(`${context} framing/order changed to group${b.code}`);
    sameValue(a.code, a.value, b.value, record, source, target, matches, context);
  }
}

const tableProperties = new Map([['APPID', [70]], ['LTYPE', [70]], ['DIMSTYLE', [70]], ['BLOCK_RECORD', [70, 280, 281]], ['LAYER', [70]], ['STYLE', [70, 71, 42]]]);
// Autodesk VPORT group282 is the default lighting type (0 one distant light, 1 two).
const vportScalars = new Set([2, 70, 10, 20, 11, 21, 12, 22, 13, 23, 14, 24, 15, 25, 16, 26, 36, 17, 27, 37, 40, 41, 42, 43, 44, 50, 51, 71, 72, 73, 74, 75, 76, 77, 78, 79, 110, 120, 130, 111, 121, 131, 112, 122, 132, 141, 142, 143, 144, 145, 146, 281, 65, 348, 60, 61, 292, 282, 63, 421, 431, 64, 441, 340, 341, 345, 346]);
function tablePayload(record) {
  const metadata = new Set(entityMetadata(record)); let common = true;
  return record.groups.filter(pair => {
    if (metadata.has(pair)) return false;
    if (pair.code === 100) { common = false; return false; }
    return ![5, 105].includes(pair.code) && !(common && pair.code === 330);
  });
}
function compareTable(record, actual, source, target, matches, label) {
  const codes = tableProperties.get(record.type), all = record.type === 'VPORT';
  if (!codes && !all) return;
  if (!actual) fail(`${label} is missing from the independently decoded DWG`);
  const first = normalizePairs(record, tablePayload(record)), second = normalizePairs(actual, tablePayload(actual));
  if (record.type === 'DIMSTYLE') {
    const a = first.filter(pair => pair.code === 70), b = second.filter(pair => pair.code === 70);
    if (!a.length || !b.length || a.length > 2 || b.length > 2) fail(`${label} has ambiguous DIMSTYLE symbol flags or text-fill colors`);
    sameValue(70, a[0].value, b[0].value, record, source, target, matches, `${label}.group70[0]`);
    // The first70 is the table flag; the second70 is R2007+ DIMTFILLCLR. The
    // native optional default is ByBlock0, which can be omitted in an older DXF.
    sameValue(70, a[1]?.value ?? '0', b[1]?.value ?? '0', record, source, target, matches, `${label}.DIMTFILLCLR`);
    const fillA = first.filter(pair => pair.code === 69), fillB = second.filter(pair => pair.code === 69);
    if (fillA.length > 1 || fillB.length > 1) fail(`${label} has duplicated DIMTFILL modes`);
    sameValue(69, fillA[0]?.value ?? '0', fillB[0]?.value ?? '0', record, source, target, matches, `${label}.DIMTFILL`);
    return;
  }
  const selected = all ? new Set(first.map(pair => pair.code).filter(code => vportScalars.has(code))) : new Set(codes);
  for (const code of selected) {
    const a = first.filter(pair => pair.code === code), b = second.filter(pair => pair.code === code);
    if (!a.length) continue;
    if (a.length !== b.length) fail(`${label}.group${code} count changed (${a.length} -> ${b.length})`);
    for (let index = 0; index < a.length; index++) sameValue(code, a[index].value, b[index].value, record, source, target, matches, `${label}.group${code}[${index}]`);
  }
  // Unknown native VPORT fields retain their ordered raw framing; only known
  // singleton properties may move between version-specific DXF serializers.
  if (all) comparePairs(record, actual, first.filter(pair => !vportScalars.has(pair.code)), second.filter(pair => !vportScalars.has(pair.code)), source, target, matches, label + '.unmodeled');
}

function headerName(variable, groups, parsed) {
  const definition = nameHeader.get(variable); if (!definition) return undefined;
  const [type, code] = definition, named = groups.find(pair => pair.code === code);
  if (named) return identifier(named.value);
  const ref = groups.find(pair => pointer(pair.code)); if (!ref) return undefined;
  const id = handle(ref.value); if (id === '0') return type === 'BLOCK_RECORD' ? '' : undefined;
  const object = parsed.handles.get(id);
  if (!object || object.type !== type) fail(`HEADER ${variable} has an incompatible ${type} reference`);
  return identifier(valueOf(object, type === 'SCALE' ? 300 : 2));
}

/**
 * Check every retained OBJECTS payload and CLASS definition, every named VIEW camera, common reactor/extension/XDATA
 * groups, and every nonvolatile source HEADER variable. Unknown class fields are compared raw.
 * @param {string} sourceDxf @param {string} targetDxf @param {readonly InventoryObject[]} [targetInventory]
 * @returns {{ schemaVersion:1, objects:number, views:number, metadataOwners:number, headerVariables:number }}
 */
export function verifyDwgMetadataEquivalence(sourceDxf, targetDxf, targetInventory) {
  const source = parse(sourceDxf), target = parse(targetDxf), matches = recordMatches(source, target);
  if (targetInventory !== undefined) verifyInventory(target, targetInventory);
  const annotations = annotationEncoding(source, target, matches);
  let objects = 0, views = 0, metadataOwners = 0, headerVariables = 0;
  for (const record of source.records) {
    const full = record.section === 'OBJECTS' || record.type === 'VIEW' || record.section === 'CLASSES' && record.type === 'CLASS';
    const subset = full ? [] : entityMetadata(record);
    const actual = matches.get(record), label = `SOURCE:${record.type}(${record.handle ?? (record.type === 'CLASS' ? valueOf(record, 1) : 'no handle')})`;
    if (record.section === 'TABLES') compareTable(record, actual, source, target, matches, label);
    if (!full && !subset.length) continue;
    if (!actual) fail(`${label} is missing from the independently decoded DWG`);
    const wanted = full ? dictionaries.has(record.type) ? dictionaryPayload(record) : record.groups : subset;
    const got = full ? dictionaries.has(actual.type) ? dictionaryPayload(actual, annotations.ignored.get(actual)) : actual.groups : entityMetadata(actual);
    comparePairs(record, actual, wanted, got, source, target, matches, label);
    if (record.section === 'OBJECTS') objects++; else if (record.type === 'VIEW') views++; else if (subset.length) metadataOwners++;
  }
  const dummy = { type: 'HEADER', section: 'HEADER', groups: [], aliases: new Set() };
  for (const [variable, groups] of source.header) {
    if (volatileHeader.has(variable)) continue;
    const got = annotations.derived.get(variable) ?? target.header.get(variable); if (!got) fail(`SOURCE:HEADER.${variable} is missing`);
    const expectedName = headerName(variable, groups, source), actualName = headerName(variable, got, target);
    if (expectedName !== undefined || actualName !== undefined) {
      if (expectedName !== actualName) fail(`SOURCE:HEADER.${variable} symbol changed (${short(expectedName)} -> ${short(actualName)})`);
    } else comparePairs(dummy, dummy, groups, got, source, target, matches, `SOURCE:HEADER.${variable}`);
    headerVariables++;
  }
  return { schemaVersion: 1, objects, views, metadataOwners, headerVariables };
}
