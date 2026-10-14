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

function geometryOwner(record) {
  let depth = 0, owner;
  for (const pair of record.groups) {
    if (pair.code === 102) { depth += pair.value.trim().startsWith('{') ? 1 : pair.value.trim() === '}' ? -1 : 0; continue; }
    if (depth) continue;
    if (pair.code === 100) break;
    if (pair.code === 330) {
      if (owner !== undefined) fail(`${record.type}(${record.handle}) has duplicated common owner references`);
      owner = pair.value;
    }
  }
  return owner;
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
    if (['DBCOLOR', 'TABLESTYLE'].includes(sourceRecord.type) && code === 420) {
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

// The R2013+ ordered property grammar is shared by the typed native writer and
// the independent C reader. Colors occupy only these eight AcGi property slots.
const visualPropertyCodes = [90, 90, 90, 90, 40, 40, 62, 90, 90, 62, 62, 90, 90, 40, 90, 62, 40, 90, 90, 90, 62, 90, 90, 90, 290, 90, 40, 90,
  290, 290, 290, 290, 290, 290, 290, 290, 290, 90, 40, 40, 90, 62, 90, 90, 62, 290, 90, 90, 90, 290, 90, 62, 40, 90, 1, 290, 40, 40];
function visualStyleColorPairs(record, pairs, parsed, label) {
  if (record.section !== 'OBJECTS' || record.type !== 'VISUALSTYLE') return pairs;
  const starts = [], top = []; let depth = 0, xdata = false;
  for (let index = 0; index < pairs.length; index++) {
    const pair = pairs[index];
    if (pair.code === 1001) xdata = true;
    if (pair.code === 102) { depth += pair.value.trim().startsWith('{') ? 1 : pair.value.trim() === '}' ? -1 : 0; continue; }
    if (!depth && !xdata) {
      top.push(pair);
      if (pair.code === 100 && pair.value.trim() === 'AcDbVisualStyle') starts.push(index);
    }
  }
  // Legacy/raw records retain exact comparisons. A second70 declares a modern
  // count; do not grant RGB equivalence to absent or ambiguous property bags.
  if (top.filter(pair => pair.code === 70).length < 2) return pairs;
  const version = parsed.header.get('$ACADVER');
  if (version && (version.length !== 1 || version[0].code !== 1 || !['AC1027', 'AC1032'].includes(version[0].value.trim()))) fail(`${label} has an unsupported VISUALSTYLE property version`);
  if (starts.length !== 1) fail(`${label} lacks a unique VISUALSTYLE property subclass`);
  let cursor = starts[0] + 1;
  const prefix = [2, 70, 177, 291, 70];
  for (const code of prefix) if (pairs[cursor++]?.code !== code) fail(`${label} has unsupported VISUALSTYLE property framing`);
  const count = pairs[cursor - 1].value.trim();
  if (!/^[+]?0*58$/.test(count)) fail(`${label} lacks the complete58 VISUALSTYLE property count`);
  const result = pairs.slice();
  for (const [slot, code] of visualPropertyCodes.entries()) {
    const at = cursor, value = pairs[cursor++], context = `${label}.property${slot}`;
    if (value?.code !== code) fail(`${context} has an unsupported VISUALSTYLE property type/order`);
    if (code === 62) {
      const aci = value.value.trim();
      if (!/^[+-]?\d{1,20}$/.test(aci) || BigInt(aci) < 0n || BigInt(aci) > 257n) fail(`${context} has invalid bounded color-index storage`);
      if (pairs[cursor]?.code === 420) {
        const rgb = pairs[cursor].value.trim();
        if (!/^[+-]?\d{1,20}$/.test(rgb)) fail(`${context} has invalid bounded RGB integer storage`);
        const word = BigInt(rgb);
        if (word < -0x80000000n || word > 0xffffffffn) fail(`${context} has invalid 32-bit RGB storage`);
        const packed = word & 0xffffffffn, method = packed >> 24n;
        if (method !== 0n && method !== 0xc2n) fail(`${context} has an unsupported RGB color method`);
        // A ByColor property is ONE typed color, not two independent values.
        // Autodesk420 takes precedence over62; CMC stores RGB/method and the
        // C reader derives62 with dwg_find_color_index. AutoCAD DXFOUT's18
        // beside blackRGB0 therefore becomes native62=0. Retain pair framing,
        // require a unique bounded companion, and compare every RGB bit.
        result[at] = { code: 62, value: '0' };
        result[cursor] = { code: 420, value: String(packed & 0xffffffn) }; cursor++;
      }
    }
    const selector = pairs[cursor++];
    if (selector?.code !== 176 || !/^[+-]?\d{1,20}$/.test(selector.value.trim()) || BigInt(selector.value.trim()) < 0n || BigInt(selector.value.trim()) > 3n) fail(`${context} has an unsupported VISUALSTYLE operation selector`);
  }
  // No additional value/selector may masquerade as part of the58-property bag.
  // Opaque suffixes (including XDATA) retain the original raw comparison.
  if (pairs[cursor] && [1, 2, 40, 62, 70, 90, 100, 176, 177, 290, 291, 420].includes(pairs[cursor].code)) fail(`${label} has excess VISUALSTYLE property framing`);
  return result;
}

/** @param {RecordData} record @param {Pair[]} pairs @param {string} subclass @param {string} label */
function retainedStyleRegion(record, pairs, subclass, label) {
  const xdata=pairs.findIndex(pair=>pair.code===1001),core=xdata<0?pairs:pairs.slice(0,xdata);
  const markers = core.flatMap((pair, index) => pair.code === 100 && pair.value.trim() === subclass ? [index] : []);
  if (markers.length !== 1) fail(`${label} has ambiguous retained style subclass framing`);
  const start = markers[0];
  // A style's common owner/reactors precede its own first subclass. The
  // remaining common/application framing is opaque and never reinterpreted.
  if (pairs.slice(0, start).some(pair => pair.code === 100 || pair.code === 1001)) fail(`${label} has malformed retained style common framing`);
  let end = pairs.findIndex((pair, index) => index > start && [100, 102, 1001].includes(pair.code));
  if (end < 0) end = pairs.length;
  return { start, end, body: pairs.slice(start + 1, end) };
}

/** @param {Pair} pair @param {number} min @param {number} max @param {string} context */
function retainedStyleInteger(pair, min, max, context) {
  const value = pair?.value?.trim();
  if (typeof value !== 'string' || !/^[+-]?\d{1,20}$/.test(value)) fail(`${context} has invalid retained style integer storage`);
  const parsed = BigInt(value);
  if (parsed < BigInt(min) || parsed > BigInt(max)) fail(`${context} has out-of-range retained style integer storage`);
  return Number(parsed);
}

/** @param {Pair} pair @param {Parsed} parsed @param {string} expected @param {string} context */
function retainedStyleReference(pair, parsed, expected, context) {
  const id = handle(pair.value);
  if (id === '0') return;
  if (parsed.handles.get(id)?.type !== expected) fail(`${context} has a missing or wrong-class retained style reference`);
}

/** @param {Pair[]} pairs @param {string} subclass @param {number} code @param {(value:string)=>boolean} [accept] */
function retainedStyleClaim(pairs,subclass,code,accept=()=>true) {
  // A duplicated early subclass cannot conceal a later declared modern bag.
  // XDATA begins the opaque suffix and cannot declare another style version.
  let body=false;
  for(const pair of pairs) {
    if(pair.code===1001) break;
    if(pair.code===100 || pair.code===102) { body=pair.code===100 && pair.value.trim()===subclass; continue; }
    if(body && pair.code===code && accept(pair.value)) return true;
  }
  return false;
}

/** @param {RecordData} record @param {Pair[]} pairs @param {Parsed} parsed @param {string} label
 * @returns {{pairs:Pair[],linetypeFields:Set<Pair>}} */
function retainedStylePairs(record, pairs, parsed, label) {
  const linetypeFields = new Set();
  if (record.section !== 'OBJECTS' || !['MLEADERSTYLE', 'MLINESTYLE'].includes(record.type)) return { pairs, linetypeFields };
  if (record.type === 'MLEADERSTYLE') {
    // Partial/legacy raw records retain the original opaque comparison. They
    // receive no new NULL or order equivalence. Only a declared version2 bag
    // is interpreted; a claimed but incomplete bag cannot take this fallback.
    if(!retainedStyleClaim(pairs,'AcDbMLeaderStyle',179,value=>/^[+-]?\d{1,20}$/.test(value.trim()) && BigInt(value.trim())===2n)) return {pairs,linetypeFields};
    const region = retainedStyleRegion(record, pairs, 'AcDbMLeaderStyle', label);
    // Complete admitted R2010/class-version2 prefix. Optional native block
    // pointers341/343 are the only missing properties materialized here.
    const required = [179,170,171,172,90,40,41,173,91,340,92,290,42,291,43,3,44,300,342,174,178,175,176,93,45,292,297,46,94,47,49,140,293,141,294,177,142,295,296,143,271,272,273,298];
    const known = new Set([...required,341,343]), slots = new Map();
    let consumed = 0;
    for (const pair of region.body) {
      if (!known.has(pair.code)) break;
      if (slots.has(pair.code)) fail(`${label} has duplicated retained style group${pair.code}`);
      slots.set(pair.code, pair); consumed++;
    }
    // A same-subclass unknown field cannot hide another known property slot.
    // Genuine new subclasses/common framing/XDATA begin outside region.body.
    if (region.body.some((pair, index) => index >= consumed && known.has(pair.code))) fail(`${label} has ambiguous interleaved MLEADERSTYLE property framing`);
    if (required.some(code => !slots.has(code))) fail(`${label} has incomplete supported MLEADERSTYLE property framing`);
    if (retainedStyleInteger(slots.get(179),2,2,`${label}.group179`) !== 2) fail(`${label} has unsupported retained MLEADERSTYLE version`);
    /** @type {[number,string][]} */ const references = [[340,'LTYPE'],[341,'BLOCK_RECORD'],[342,'STYLE'],[343,'BLOCK_RECORD']];
    for (const [code, type] of references) {
      const pair = slots.get(code); if (pair) retainedStyleReference(pair,parsed,type,`${label}.group${code}`);
    }
    const body = region.body.slice(0,consumed), tail = body.slice(-4);
    if (tail[0]?.code !== 271 || tail[3]?.code !== 298 || ![272,273].includes(tail[1]?.code) || ![272,273].includes(tail[2]?.code)) fail(`${label} has unsupported MLEADERSTYLE attachment framing`);
    const prefix = [];
    for (const pair of body.slice(0,-4)) {
      if ([341,343].includes(pair.code)) continue;
      if (pair.code === 44) prefix.push(slots.get(341) ?? { code:341,value:'0' });
      if (pair.code === 94) prefix.push(slots.get(343) ?? { code:343,value:'0' });
      prefix.push(pair);
    }
    return { pairs:[...pairs.slice(0,region.start+1),...prefix,slots.get(271),slots.get(273),slots.get(272),slots.get(298),...region.body.slice(consumed),...pairs.slice(region.end)], linetypeFields };
  }
  if(!retainedStyleClaim(pairs,'AcDbMlineStyle',71)) return {pairs,linetypeFields};
  const region = retainedStyleRegion(record,pairs,'AcDbMlineStyle',label), body = region.body;
  const prefix = [2,70,3,62,51,52,71];
  if (prefix.some((code,index) => body[index]?.code !== code)) fail(`${label} has unsupported MLINESTYLE property framing`);
  const count = retainedStyleInteger(body[6],0,255,`${label}.group71`);
  const flags = retainedStyleInteger(body[1],0,0x773,`${label}.group70`);
  if (flags & ~0x773) fail(`${label} has unsupported MLINESTYLE flags`);
  let cursor = prefix.length;
  for (let index=0; index<count; index++) {
    if (body[cursor]?.code !== 49 || body[cursor+1]?.code !== 62 || body[cursor+2]?.code !== 6) fail(`${label} has changed MLINESTYLE element count or framing`);
    linetypeFields.add(body[cursor+2]); cursor += 3;
  }
  if (body[cursor] && [...prefix,49,6].includes(body[cursor].code)) fail(`${label} has excess or duplicated MLINESTYLE property framing`);
  return { pairs,linetypeFields };
}

// Parsed inputs are private synchronous verifier snapshots. Cache only proven
// table/name/owner evidence for this exact parse, so huge common/XDATA tails
// are not rescanned per element. Weak keys release all evidence after a call.
/** @type {WeakMap<Parsed,{control:RecordData,entries:Map<RecordData,string>}>} */
const retainedLinetypeEvidence=new WeakMap();

/** @param {string} value @param {Parsed} parsed @param {string} context @returns {{record:RecordData,control:RecordData}} */
function retainedLinetype(value, parsed, context) {
  // Native symbol lookup is case-insensitive. This bounded correction proves
  // ASCII spelling differences only; Unicode aliases are not inferred.
  const name = unicode(value), ascii = text => /^[\x00-\x7f]*$/.test(text), fold = text => text.replace(/[a-z]/g,character=>character.toUpperCase());
  // parse/assignAliases already rejects duplicate logical names. Use that
  // authenticated per-parse index rather than rescan every record per element.
  // Its generic lookup only selects a candidate; exact/ASCII-name, class and
  // owner checks below prove the reference and reject Unicode/trim aliases.
  let evidence=retainedLinetypeEvidence.get(parsed);
  if(!evidence) {
    const control=parsed.aliases.get('table-control:LTYPE'),names=control?.groups.filter(pair=>pair.code===2)??[];
    if(control?.section!=='TABLES' || control.type!=='TABLE' || !control.handle || names.length!==1 || fold(names[0].value)!=='LTYPE') fail(`${context} has no unique retained LTYPE table control`);
    evidence={control,entries:new Map()};retainedLinetypeEvidence.set(parsed,evidence);
  }
  const {control}=evidence,candidate=parsed.aliases.get('table:LTYPE:'+identifier(name));
  if(!candidate) fail(`${context} has a missing retained LTYPE target`);
  let stored=evidence.entries.get(candidate);
  if(stored===undefined) {
    if(candidate.section!=='TABLES' || candidate.type!=='LTYPE' || !candidate.handle || commonOwner(candidate)!==control.handle) fail(`${context} has a missing, ambiguous or disconnected retained LTYPE target`);
    const names=candidate.groups.filter(pair=>pair.code===2);
    if(names.length!==1) fail(`${context} has ambiguous retained LTYPE name framing`);
    stored=unicode(names[0].value);evidence.entries.set(candidate,stored);
  }
  if(stored!==name && !(ascii(name) && ascii(stored) && fold(stored)===fold(name))) fail(`${context} has a missing or unproven retained LTYPE target`);
  return {record:candidate,control};
}

/** @param {string} first @param {string} second @param {Parsed} source @param {Parsed} target @param {Map<RecordData,RecordData>} matches @param {string} context */
function sameRetainedLinetype(first,second,source,target,matches,context) {
  const original = retainedLinetype(first,source,context), actual = retainedLinetype(second,target,context);
  if (matches.get(original.record) !== actual.record || matches.get(original.control)!==actual.control) fail(`${context} retained LTYPE reference changed or lost its target`);
}

// TABLESTYLE's two independently named common reference groups have no
// relative order: AutoCAD/C emit XD then reactors, while the checked legacy
// projection emits reactors then XD. Compare their complete retained payloads
// in one order, without moving them past any owner/scalar/opaque boundary.
function tableStyleCommonPairs(record, pairs, label) {
  if (record.section !== 'OBJECTS' || record.type !== 'TABLESTYLE') return pairs;
  const known = new Map([['{ACAD_REACTORS', 330], ['{ACAD_XDICTIONARY', 360]]);
  // 100/1001 inside an opaque102 application is application data, not the
  // object's subclass/XDATA boundary. Its entire payload remains compared.
  let end = pairs.length, commonDepth = 0, claimedCommon = false;
  for (let index = 0; index < pairs.length; index++) {
    const pair = pairs[index];
    if (!commonDepth && (pair.code === 100 || pair.code === 1001)) { end = index; break; }
    if (index >= 16384) {
      if (claimedCommon) fail(`${label} common prefix exceeds its framing budget`);
      return pairs; // No order equivalence for a large opaque-only raw prefix.
    }
    if (pair.code === 102) {
      const value = pair.value.trim();
      if (known.has(value)) claimedCommon = true;
      if (value.startsWith('{')) commonDepth++;
      else if (value === '}' && commonDepth) commonDepth--;
    }
  }
  const prefix = pairs.slice(0, end);
  if (!claimedCommon) return pairs;
  if (prefix.length > 16384) fail(`${label} common prefix exceeds its framing budget`);
  const blocks = new Map(); let cursor = 0;
  while (prefix[cursor]?.code === 102 && known.has(prefix[cursor].value.trim())) {
    const opening = prefix[cursor++], key = opening.value.trim(), code = known.get(key), block = [opening];
    if (blocks.has(key)) fail(`${label} has duplicated TABLESTYLE common reference groups`);
    let count = 0;
    while (cursor < prefix.length && prefix[cursor].code !== 102) {
      const pair = prefix[cursor++];
      if (pair.code !== code || handle(pair.value) === '0' || ++count > (code === 330 ? 1024 : 1)) fail(`${label} has invalid TABLESTYLE common reference payload`);
      block.push(pair);
    }
    const closing = prefix[cursor++];
    if (!count || closing?.code !== 102 || closing.value.trim() !== '}') fail(`${label} has incomplete or nested TABLESTYLE common reference framing`);
    block.push(closing); blocks.set(key, block);
  }
  // The owner remains at its original boundary; known groups cannot migrate
  // around it, an opaque common application, or any unrelated scalar.
  const owner = prefix[cursor++];
  if (owner?.code !== 330) fail(`${label} has interleaved TABLESTYLE common reference framing`);
  handle(owner.value);
  const tail = prefix.slice(cursor); let depth = 0;
  for (const pair of tail) {
    if (pair.code === 102) {
      const value = pair.value.trim();
      if (known.has(value)) fail(`${label} has duplicated or interleaved TABLESTYLE common reference framing`);
      if (value.startsWith('{') && !depth) depth = 1;
      else if (value === '}' && depth) depth = 0;
      else fail(`${label} has nested or malformed TABLESTYLE common application framing`);
    } else if (!depth && [5, 105, 330, 360].includes(pair.code)) fail(`${label} has ambiguous TABLESTYLE common owner/reference framing`);
  }
  if (depth) fail(`${label} has incomplete TABLESTYLE common application framing`);
  return [...(blocks.get('{ACAD_REACTORS') ?? []), ...(blocks.get('{ACAD_XDICTIONARY') ?? []), owner, ...tail, ...pairs.slice(end)];
}

function comparePairs(record, actual, sourcePairs, targetPairs, source, target, matches, label) {
  const firstStyle = retainedStylePairs(record, tableStyleCommonPairs(record, normalizePairs(record, sourcePairs), label), source, label);
  const secondStyle = retainedStylePairs(actual, tableStyleCommonPairs(actual, normalizePairs(actual, targetPairs), label), target, label);
  const first = visualStyleColorPairs(record, firstStyle.pairs, source, label), second = visualStyleColorPairs(actual, secondStyle.pairs, target, label);
  if (first.length !== second.length) fail(`${label} group count changed (${first.length} -> ${second.length})`);
  for (let index = 0; index < first.length; index++) {
    const a = first[index], b = second[index], context = `${label}.group${a.code}[${index}]`;
    if (a.code !== b.code) fail(`${context} framing/order changed to group${b.code}`);
    if (firstStyle.linetypeFields.has(a) || secondStyle.linetypeFields.has(b)) {
      if (!firstStyle.linetypeFields.has(a) || !secondStyle.linetypeFields.has(b)) fail(`${context} typed linetype framing changed`);
      sameRetainedLinetype(a.value, b.value, source, target, matches, context);
    } else sameValue(a.code, a.value, b.value, record, source, target, matches, context);
  }
}

// AutoCAD DXFOUT represents R2010+ TABLESTYLE rows in the legacy record and
// retains its ordered native overrides in an owned CELLSTYLEMAP. Admit this
// representation only after every legacy property has an exact native value.
// The original record, links, XDATA and full map are still checked separately.
function legacyTableStyleProjection(record, source) {
  const subclass = record.groups.findIndex(pair => pair.code === 100 && pair.value.trim() === 'AcDbTableStyle');
  if (subclass < 0) fail('legacy TABLESTYLE lacks its subclass');
  const prefix = new Map();
  for (let index = 0; index < subclass; index++) {
    const pair = record.groups[index];
    if (pair.code === 102 && ['{ACAD_REACTORS', '{ACAD_XDICTIONARY'].includes(pair.value)) {
      const key = pair.value, code = key === '{ACAD_REACTORS' ? 330 : 360, group = [pair];
      if (prefix.has(key)) fail('legacy TABLESTYLE has duplicate common links');
      while (++index < subclass && record.groups[index].code !== 102) {
        if (record.groups[index].code !== code || group.length > 1024) fail('legacy TABLESTYLE common link framing is invalid'); group.push(record.groups[index]);
      }
      if (record.groups[index]?.value !== '}' || (code === 360 && group.length !== 2)) fail('legacy TABLESTYLE common links are incomplete');
      group.push(record.groups[index]); prefix.set(key, group);
    } else {
      if (![5, 330].includes(pair.code) || prefix.has(pair.code)) fail('legacy TABLESTYLE has unrepresentable common properties'); prefix.set(pair.code, [pair]);
    }
  }
  const tail = record.groups.findIndex((pair, index) => index > subclass && pair.code === 1001);
  const end = tail < 0 ? record.groups.length : tail;
  const header = new Map(), rows = []; let row, sawName = false;
  const store = (map, pair) => { if (map.has(pair.code)) fail(`legacy TABLESTYLE duplicates group${pair.code}`); map.set(pair.code, pair.value); };
  for (const pair of record.groups.slice(subclass + 1, end)) {
    if (pair.code === 7) { if (rows.length === 3) fail('legacy TABLESTYLE has more than three rows'); row = new Map(); rows.push(row); store(row, pair); }
    else if (row) {
      if (![1, 140, 170, 62, 63, 283, 90, 91, ...Array.from({ length: 6 }, (_, i) => 274 + i), ...Array.from({ length: 6 }, (_, i) => 284 + i), ...Array.from({ length: 6 }, (_, i) => 64 + i), ...Array.from({ length: 8 }, (_, i) => 420 + i)].includes(pair.code)) fail(`legacy TABLESTYLE has unrepresentable row group${pair.code}`);
      store(row, pair);
    } else {
      if (![3, 70, 71, 40, 41, 280, 281].includes(pair.code)) fail(`legacy TABLESTYLE has unrepresentable header group${pair.code}`);
      const code = pair.code === 280 && !sawName ? -280 : pair.code;
      store(header, { code, value: pair.value }); if (pair.code === 3) sawName = true;
    }
  }
  if (!header.has(3)) fail('legacy TABLESTYLE has no name');
  const number = (map, code, fallback) => {
    const value = map.get(code) ?? String(fallback);
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()) || !Number.isFinite(Number(value))) fail(`legacy TABLESTYLE has invalid numeric group${code}`);
    return Number(value);
  };
  const int = (map, code, fallback, min, max) => {
    const value = map.get(code) ?? String(fallback);
    if (!/^[+-]?\d{1,10}$/.test(value.trim()) || Number(value) < min || Number(value) > max) fail(`legacy TABLESTYLE has invalid integer group${code}`);
    return Number(value);
  };
  if (int(header, -280, 0, 0, 255) !== 0 || int(header, 70, 0, 0, 1) !== 0) fail('legacy TABLESTYLE version/flow has no exact modern encoding');
  let flags = int(header, 71, 0, -32768, 32767);
  const title = int(header, 280, flags & 1 ? 1 : 0, 0, 1), heading = int(header, 281, flags & 2 ? 1 : 0, 0, 1);
  if (header.has(71) && ((flags & 1 ? 1 : 0) !== title || (flags & 2 ? 1 : 0) !== heading)) fail('legacy TABLESTYLE has conflicting source flag/suppression values');
  flags = (flags & ~3) | (title ? 1 : 0) | (heading ? 2 : 0);
  const horizontal = number(header, 40, .06), vertical = number(header, 41, .06);
  const pairs = values => values.map(([code, value]) => ({ code, value: String(value) }));
  const color = (map, aciCode, rgbCode, fallback) => {
    const aci = int(map, aciCode, fallback, 0, 257), rgb = map.get(rgbCode);
    if (rgb === undefined) return pairs([[62, aci]]);
    if (aci !== 0) fail('legacy TABLESTYLE has an unrepresentable true-color fallback index');
    const word = int(map, rgbCode, 0, -2147483648, 4294967295) >>> 0;
    if (![0, 0xc2].includes(word >>> 24)) fail('legacy TABLESTYLE has an unsupported true-color method');
    return pairs([[62, 0], [420, (word & 0xffffff) | 0xc2000000]]);
  };
  const styleHandle = map => {
    const name = identifier(map.get(7) ?? 'Standard'), style = source.aliases.get(`table:STYLE:${name}`);
    if (!style?.handle) fail('legacy TABLESTYLE names a missing STYLE'); return style.handle;
  };
  const content = (map, alignment, height, base = false) => [
    ...pairs([[300, 'CONTENTFORMAT'], [1, 'CONTENTFORMAT_BEGIN'], [90, 0], [91, 0], [92, int(map, 90, 512, -2147483648, 2147483647)], [93, int(map, 91, 0, -2147483648, 2147483647)], [300, map.get(1) ?? ''], [40, 0], [140, 1], [94, int(map, 170, alignment, 1, 9)]]),
    ...color(map, 62, 420, 0), ...pairs([[340, base ? '0' : styleHandle(map)], [144, number(map, 140, height)], [309, 'CONTENTFORMAT_END']]),
  ];
  const named = (body, id, type, name) => [...body, ...pairs([[309, 'TABLEFORMAT_END'], [1, 'CELLSTYLE_BEGIN'], [90, id], [91, type], [300, name], [309, 'CELLSTYLE_END']])];
  const base = named([
    ...pairs([[1, 'TABLEFORMAT_BEGIN'], [90, 5], [170, 1], [91, 0], [92, 0], [62, 257], [93, 1]]), ...content(new Map(), 1, .18, true),
    ...pairs([[171, 1], [301, 'MARGIN'], [1, 'CELLMARGIN_BEGIN'], [40, vertical], [40, horizontal], [40, vertical], [40, horizontal], [40, .18], [40, .18], [309, 'CELLMARGIN_END'], [94, 0]]),
  ], 4, 2, 'Table');
  /** @type {Array<[number,string,number,number,number,number,number]>} */
  const rowSpecs = [[1, '_TITLE', 1, 1, 0x8000, 2, .25], [2, '_HEADER', 2, 1, 0, 2, .25], [0, '_DATA', 3, 2, 0, 5, .18]];
  const generated = rowSpecs.map(([index, name, id, type, merge, alignment, height]) => {
    const map = rows[index] ?? new Map(), declared = rows[index] !== undefined;
    if (!int(map, 283, 0, 0, 1) && (int(map, 63, 7, 0, 257) !== 7 || map.has(421))) fail('legacy TABLESTYLE inactive fill color has no exact native encoding');
    const borders = [1, 2, 4, 8, 16, 32].flatMap((mask, index) => [
      ...pairs([[95, mask], [302, 'GRIDFORMAT'], [1, 'GRIDFORMAT_BEGIN'], [90, 0], [91, 1]]), ...color(map, 64 + index, 422 + index, 0),
      ...pairs([[92, int(map, 274 + index, -2, -3, 211)], [340, '0'], [93, 1 - int(map, 284 + index, 1, 0, 1)], [40, 0], [309, 'GRIDFORMAT_END']]),
    ]);
    return named([
      ...pairs([[1, 'TABLEFORMAT_BEGIN'], [90, 5], [170, 1], [91, 0], [92, merge]]), ...(int(map, 283, 0, 0, 1) ? color(map, 63, 421, 7) : pairs([[62, 257]])),
      ...pairs([[93, 1]]), ...content(map, declared ? 5 : alignment, declared ? .18 : height), ...pairs([[171, 0], [94, 6]]), ...borders,
    ], id, type, name);
  });
  const extension = record.groups.findIndex(pair => pair.code === 102 && pair.value === '{ACAD_XDICTIONARY');
  const extensionHandle = extension < 0 ? undefined : record.groups[extension + 1];
  let overrides = generated, keys = [1, 2, 3];
  if (extensionHandle?.code === 360) {
    const dictionary = source.handles.get(handle(extensionHandle.value));
    if (!dictionary || dictionary.type !== 'DICTIONARY') fail('legacy TABLESTYLE extension dictionary is missing');
    const entries = dictionaryEntries(dictionary, source), map = entries.get('ACAD_ROUNDTRIP_2008_TABLESTYLE_CELLSTYLEMAP');
    if (map) {
      if (map.type !== 'CELLSTYLEMAP') fail('legacy TABLESTYLE roundtrip map has the wrong class');
      const parts = []; let start;
      map.groups.forEach((pair, index) => {
        if (pair.code === 1 && pair.value === 'TABLEFORMAT_BEGIN') { if (start !== undefined) fail('nested legacy TABLESTYLE cell format'); start = index; }
        if (pair.code === 309 && pair.value === 'CELLSTYLE_END') { if (start === undefined) fail('unmatched legacy TABLESTYLE cell format'); parts.push(map.groups.slice(start, index + 1)); start = undefined; }
      });
      if (start !== undefined || parts.length < 3 || parts.length > 64) fail('legacy TABLESTYLE roundtrip map is incomplete or oversized');
      keys = parts.map(part => { const begin = part.findIndex(pair => pair.code === 1 && pair.value === 'CELLSTYLE_BEGIN'); if (begin < 0 || part[begin + 1]?.code !== 90) fail('legacy TABLESTYLE cell identity is malformed'); return int(new Map([[90, part[begin + 1].value]]), 90, 0, -2147483648, 2147483647); });
      overrides = parts;
      // Native map formats are retained verbatim. Check all legacy row values
      // against the defaults or explicit fields in those exact native formats.
      for (let index = 0; index < rowSpecs.length; index++) {
        const name = rowSpecs[index][1], row = rows[rowSpecs[index][0]] ?? new Map();
        const matching = parts.filter(part => part.some((pair, at) => pair.code === 300 && pair.value === name && part[at - 1]?.code === 91));
        if (matching.length !== 1) fail('legacy TABLESTYLE requires a unique native row format');
        compareLegacyRow(row, matching[0], styleHandle, number, int, color);
      }
    }
  }
  return [
    ...[5, '{ACAD_REACTORS', '{ACAD_XDICTIONARY', 330].flatMap(key => prefix.get(key) ?? []), ...pairs([[102, '{JCAD_TABLESTYLE_NATIVE_V1'], [90, flags], [91, 101], [360, '0'], [92, overrides.length], ...keys.map(key => [93, key]), [102, '}']]),
    record.groups[subclass], ...pairs([[70, 0], [3, header.get(3)]]), ...base, ...overrides.flat(), ...record.groups.slice(end),
  ];
}

function compareLegacyRow(row, part, styleHandle, number, int, color) {
  const start = part.findIndex(pair => pair.code === 1 && pair.value === 'CONTENTFORMAT_BEGIN'), end = part.findIndex((pair, index) => index > start && pair.code === 309 && pair.value === 'CONTENTFORMAT_END');
  if (start < 0 || end < 0) fail('legacy TABLESTYLE native row has no complete content format');
  const content = part.slice(start + 1, end), cell = part.slice(0, start - 1);
  const one = (values, code) => { const found = values.filter(pair => pair.code === code); if (found.length !== 1) fail(`legacy TABLESTYLE native row group${code} is missing or duplicated`); return found[0].value; };
  for (const [legacy, native, fallback] of [[90, 92, 512], [91, 93, 0], [170, 94, 5], [140, 144, .18]]) {
    if (number(row, legacy, fallback) !== Number(one(content, native))) fail(`legacy TABLESTYLE row group${legacy} differs from its retained native format`);
  }
  if ((row.get(1) ?? '') !== one(content, 300) || handle(one(content, 340)) !== styleHandle(row)) fail('legacy TABLESTYLE row format/text-style identity differs from its retained native format');
  const sameColor = (map, aciCode, rgbCode, fallback, values) => {
    const expected = color(map, aciCode, rgbCode, fallback), actual = values.filter(pair => [62, 420].includes(pair.code));
    if (expected.length !== actual.length || expected.some((pair, index) => pair.code !== actual[index].code || (pair.code === 420 ? (Number(pair.value) >>> 0) & 0xffffff : Number(pair.value)) !== (pair.code === 420 ? (Number(actual[index].value) >>> 0) & 0xffffff : Number(actual[index].value)))) fail('legacy TABLESTYLE row color differs from its retained native format');
  };
  sameColor(row, 62, 420, 0, content);
  if (int(row, 283, 0, 0, 1)) sameColor(row, 63, 421, 7, cell);
  else if (Number(one(cell, 62)) !== 257 || cell.some(pair => pair.code === 420)) fail('legacy TABLESTYLE disabled fill differs from its retained native format');
  for (let index = 0; index < 6; index++) {
    const mask = [1, 2, 4, 8, 16, 32][index], starts = part.flatMap((pair, at) => pair.code === 95 && Number(pair.value) === mask ? [at] : []);
    if (starts.length > 1) fail('legacy TABLESTYLE has duplicate native grid masks');
    if (!starts.length) {
      if (int(row, 274 + index, -2, -3, 211) !== -2 || int(row, 284 + index, 1, 0, 1) !== 1 || int(row, 64 + index, 0, 0, 257) !== 0 || row.has(422 + index)) fail('legacy TABLESTYLE explicit border differs from the native default');
    } else {
      const begin = starts[0], stop = part.findIndex((pair, at) => at > begin && pair.code === 309 && pair.value === 'GRIDFORMAT_END');
      if (stop < 0) fail('legacy TABLESTYLE native border is incomplete'); const grid = part.slice(begin, stop);
      if (int(row, 274 + index, -2, -3, 211) !== Number(one(grid, 92)) || int(row, 284 + index, 1, 0, 1) !== 1 - Number(one(grid, 93))) fail('legacy TABLESTYLE border weight/visibility differs from its retained native format');
      sameColor(row, 64 + index, 422 + index, 0, grid);
    }
  }
}

// AutoCAD's compact AC1032 built-ins retain six complete mapper matrices. The
// pinned native encoder writes their full typed defaults; C emits that native
// grammar, including an unused diffuse texture tuple. Account for every added
// value without granting defaults to arbitrary/custom MATERIAL records.
function builtinMaterialProjection(record, actual, source, target) {
  if (record.section !== 'OBJECTS' || record.type !== 'MATERIAL') return undefined;
  const version = parsed => {
    const values = parsed.header.get('$ACADVER');
    return values?.length === 1 && values[0].code === 1 && values[0].value.trim() === 'AC1032';
  };
  if (!version(source) || !version(target)) return undefined;
  const starts = record.groups.flatMap((pair, index) => pair.code === 100 && pair.value.trim() === 'AcDbMaterial' ? [index] : []);
  if (starts.length !== 1) return undefined;
  const begin = starts[0] + 1, end = record.groups.findIndex((pair, index) => index >= begin && pair.code === 1001);
  const body = record.groups.slice(begin, end < 0 ? undefined : end), name = body[0]?.value;
  if (body[0]?.code !== 1 || !['ByBlock', 'ByLayer', 'Global'].includes(name) || body[1]?.code !== 72) return undefined;
  // An unchanged compact record keeps the original full comparison. The
  // checked native expansion applies only when the target gained its body.
  const targetMarkers = actual.groups.flatMap((pair, index) => pair.code === 100 && pair.value.trim() === 'AcDbMaterial' ? [index] : []);
  if (targetMarkers.length === 1 && actual.groups[targetMarkers[0] + 1]?.code === 1 && actual.groups[targetMarkers[0] + 2]?.code === 72) return undefined;
  const slot = `dictionary:[]/key:"ACAD_MATERIAL"/key:${JSON.stringify(name)}`;
  const owned = (parsed, material) => {
    const root = parsed.aliases.get('dictionary:[]'), owner = root && dictionaryEntries(root, parsed).get('ACAD_MATERIAL');
    return owner && dictionaries.has(owner.type) && commonOwner(owner) === root.handle
      && dictionaryEntries(owner, parsed).get(name) === material && commonOwner(material) === owner.handle && material.aliases.has(slot);
  };
  if (!actual || !owned(source, record) || !owned(target, actual)) fail('compact built-in MATERIAL lacks its exact ACAD_MATERIAL ownership slot');
  const maps = [[72, 43], [77, 47], [171, 49], [175, 142], [179, 144], [undefined, 147]];
  const matrices = [], flags = []; let cursor = 1;
  for (const [sourceCode, matrixCode] of maps) {
    if (sourceCode !== undefined) {
      const pair = body[cursor++];
      if (pair?.code !== sourceCode || !/^[+]?0+$/.test(pair.value.trim())) fail('compact built-in MATERIAL has an unsupported scene-source flag');
      flags.push(pair);
    }
    const matrix = [];
    for (let index = 0; index < 16; index++) {
      const pair = body[cursor++];
      if (pair?.code !== matrixCode || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(pair.value.trim()) || !Number.isFinite(Number(pair.value))) fail('compact built-in MATERIAL lacks a complete finite ordered mapper matrix');
      matrix.push(pair);
    }
    matrices.push(matrix);
  }
  if (cursor !== body.length) fail('compact built-in MATERIAL has unconsumed source properties');
  const injected = new Set();
  const pairs = values => values.map(([code, value]) => { const pair = { code, value: String(value) }; injected.add(pair); return pair; });
  const projected = [...record.groups.slice(0, begin), body[0], ...pairs([[2, ''], [70, 0], [40, 1], [71, 0], [41, 1]])];
  const mapper = (index, scalar) => projected.push(...pairs(scalar), ...matrices[index], ...(index < 5 ? [flags[index]] : pairs([[273, 0]])));
  mapper(0, [[42, 1], [73, 2], [74, 1], [75, 1]]);
  // This exact zero tuple is an unused Texture_diffusemap projection after
  // source72=0, not permission to discard arbitrary advanced460/461 values.
  projected.push(...pairs([[277, 0], [278, 0], [460, 0], [279, 0], [461, 0], [76, 0], [45, 1], [44, .5]]));
  mapper(1, [[46, 1], [78, 2], [79, 1], [170, 1]]);
  mapper(2, [[48, 1], [172, 2], [173, 1], [174, 1]]);
  mapper(3, [[140, 1], [141, 1], [176, 2], [177, 1], [178, 1]]);
  mapper(4, [[143, 1], [270, 2], [271, 1], [272, 1]]);
  mapper(5, [[145, 1], [146, 1], [274, 2], [275, 1], [276, 1]]);
  projected.push(...pairs([[94, 127]]), ...(end < 0 ? [] : record.groups.slice(end)));
  const expected = normalizePairs(record, projected), observed = normalizePairs(actual, actual.groups);
  if (expected.length !== observed.length) fail('compact built-in MATERIAL native group count changed');
  for (let index = 0; index < expected.length; index++) {
    const pair = expected[index]; if (!injected.has(pair)) continue;
    const found = observed[index], raw = found.value.trim(), context = `compact built-in MATERIAL default group${pair.code}`;
    if (found.code !== pair.code) fail(`${context} framing/order changed`);
    if (integer(pair.code)) {
      const limit = pair.code === 94 ? 0x7fffffffn : 0x7fffn;
      if (!/^[+-]?\d{1,20}$/.test(raw) || BigInt(raw) < -limit - 1n || BigInt(raw) > limit || BigInt(raw) !== BigInt(pair.value)) fail(`${context} changed or has invalid bounded integer storage`);
    } else if (real(pair.code)) {
      const zero = /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:e[+-]?\d+)?$/i.test(raw);
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) || !Number.isFinite(Number(raw)) || Number(raw) !== Number(pair.value) || pair.value === '0' && !zero) fail(`${context} changed`);
    } else if (found.value !== pair.value) fail(`${context} changed`);
  }
  return projected;
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
function vportAmbientRgb(value, context) {
  if (!/^[+-]?\d{1,20}$/.test(value.trim())) fail(`${context} has invalid bounded ambient-color integer storage`);
  const word = BigInt(value.trim());
  if (word < -0x80000000n || word > 0xffffffffn) fail(`${context} has invalid 32-bit ambient-color storage`);
  const packed = word & 0xffffffffn, method = packed >> 24n;
  // Autodesk DXF421 is 0x00RRGGBB; the independent C projection also exposes
  // native AcCmEntityColor ByColor (0xC2RRGGBB). No other color method is RGB.
  if (method !== 0n && method !== 0xc2n) fail(`${context} has an unsupported ambient-color method`);
  return packed & 0xffffffn;
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
    if (all && code === 421) {
      if (a.length !== 1) fail(`${label}.group421 has ambiguous ambient-color storage`);
      const context = `${label}.group421[0]`;
      if (vportAmbientRgb(a[0].value, context) !== vportAmbientRgb(b[0].value, context)) fail(`${context} ambient RGB changed`);
      continue;
    }
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
    if (['ENTITIES', 'BLOCKS'].includes(record.section)) {
      const owner = geometryOwner(record);
      if (owner !== undefined) {
        if (!actual) fail(`${label} with a declared owner is missing from the independently decoded DWG`);
        const observed = geometryOwner(actual);
        if (observed === undefined) fail(`${label}.owner is missing from the independently decoded DWG`);
        sameValue(330, owner, observed, record, source, target, matches, `${label}.owner`);
      }
    }
    if (!full && !subset.length) continue;
    if (!actual) fail(`${label} is missing from the independently decoded DWG`);
    const legacyStyle = record.type === 'TABLESTYLE' && !record.groups.some(pair => pair.code === 1 && pair.value === 'TABLEFORMAT_BEGIN') && actual.groups.some(pair => pair.code === 1 && pair.value === 'TABLEFORMAT_BEGIN');
    const material = builtinMaterialProjection(record, actual, source, target);
    const wanted = material ?? (legacyStyle ? legacyTableStyleProjection(record, source) : full ? dictionaries.has(record.type) ? dictionaryPayload(record) : record.groups : subset);
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
