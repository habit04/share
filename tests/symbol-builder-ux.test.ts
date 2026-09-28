/**
 * Symbol Builder review fixes: pins from geometry (MIRROR / ROTATE safe), check
 * rules, vertical variants, round-trip fidelity, meta in the undo history,
 * attribute defaults, rename flow, NO / NC twins, harvest base point and stub
 * snapping, name normalisation.
 */
import { describe, it, expect } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import type { AttributeDef, BlockDef, Entity, LineEntity, TextEntity } from '../src/core/entities';
import { newId, mirrorEntityAcross, rotateEntity } from '../src/core/entities';
import { findSymbol } from '../src/electrical/symbols';
import { UserLibrary, memoryUserLibraryStore } from '../src/electrical/userlib';
import { writeDxf, readDxf } from '../src/io/dxf';
import {
  blankSymbolState,
  blockToSymbolState,
  symbolStateToBlock,
  harvestBlock,
  compilePins,
  compilePlaceholders,
  markerUpdates,
  checkSymbol,
  defaultMeta,
  metaOf,
  withMeta,
  placeholderEntity,
  pinMarkerEntity,
  pinMarkerText,
  markerTag,
  markerDefault,
  markerText,
  verticalVariant,
  verticalName,
  createTwin,
  twinName,
  twinPin,
  twinDescription,
  resolveBasePoint,
  snapStubEndpoints,
  templatePlaceholders,
  attributeDefaults,
  normalizeSymbolName,
  applyRenameChoice,
  summarizeCheck,
  directionAt,
  SYMATTR_LAYER,
  SYMPIN_LAYER,
  type SymbolMeta,
  type SymbolState,
} from '../src/electrical/symbol-builder-core';
import { validBlockName } from '../src/tools/blocks';
import { PlaceEntityTool } from '../src/tools/symbol-builder';
import { fakeContext, drive } from './fake-context';

const line = (x1: number, y1: number, x2: number, y2: number, layer = '0'): LineEntity => ({ id: newId(), layer, color: 'ByLayer', type: 'line', a: { x: x1, y: y1 }, b: { x: x2, y: y2 } });
const text = (value: string, x: number, y: number, layer = '0'): TextEntity => ({ id: newId(), layer, color: 'ByLayer', type: 'text', position: { x, y }, text: value, height: 0.1, rotation: 0, align: 'center' });
const attr = (tag: string, x: number, y: number, extra: Partial<AttributeDef> = {}): AttributeDef => ({ tag, prompt: tag, default: '', position: { x, y }, height: 0.1, align: 'center', ...extra });
const byTag = (b: BlockDef) => Object.fromEntries(b.attributes.map((a) => [a.tag, a]));
const opts = { isBuiltin: (n: string) => !!findSymbol(n), isUser: () => false, validName: validBlockName };
const errors = (msgs: ReturnType<typeof checkSymbol>) => msgs.filter((m) => m.level === 'error').map((m) => m.text);
const warnings = (msgs: ReturnType<typeof checkSymbol>) => msgs.filter((m) => m.level === 'warning').map((m) => m.text);

/** A push button with explicit pin markers carrying 13 / 14 (the way a copied HPB11_NO looks). */
function pushButton(name = 'USER_PB1', withMarkers = true): SymbolState {
  const meta = defaultMeta({ name, family: 'PB', category: 'Test', description: 'Push button NO' });
  const entities: Entity[] = [line(-0.375, 0, -0.125, 0), line(0.125, 0, 0.375, 0), line(-0.125, -0.125, -0.125, 0.125), line(0.125, -0.125, 0.125, 0.125), placeholderEntity('TAG1'), placeholderEntity('DESC1')];
  if (withMarkers) entities.push(pinMarkerText('X1TERM01', { x: -0.375, y: 0 }, '13'), pinMarkerText('X4TERM02', { x: 0.375, y: 0 }, '14'));
  const state: DrawingState = { ...blankSymbolState(meta), entities };
  return { state, meta };
}

describe('pins from geometry', () => {
  it('derives the direction from where the marker sits, keeps the default number, and renumbers marker texts after MIRROR', () => {
    const { state, meta } = pushButton();
    const before = compilePins(state, meta);
    expect(before.map((p) => [p.tag, p.default])).toEqual([
      ['X1TERM01', '13'],
      ['X4TERM02', '14'],
    ]);
    // MIRROR about the y axis: the marker that says X1 now sits on the right stub end.
    const mirrored: DrawingState = { ...state, entities: state.entities.map((e) => mirrorEntityAcross(e, { x: 0, y: 0 }, { x: 0, y: 1 })) };
    const pins = compilePins(mirrored, meta);
    expect(pins.map((p) => [p.tag, p.default, p.point.x])).toEqual([
      ['X1TERM01', '14', -0.375],
      ['X4TERM02', '13', 0.375],
    ]);
    expect(pins.every((p) => p.onEndpoint)).toBe(true);
    // The texts on the canvas disagree with the compiled tags until they are renumbered.
    const updates = markerUpdates(mirrored, pins);
    expect(updates.map((u) => u.text).sort()).toEqual(['X1TERM01=14', 'X4TERM02=13']);
    const left = updates.find((u) => u.text === 'X1TERM01=14')!;
    expect(left.align).toBe('right'); // label reads away from the symbol
    const renumbered: DrawingState = { ...mirrored, entities: mirrored.entities.map((e) => updates.find((u) => u.id === e.id) ?? e) };
    expect(markerUpdates(renumbered, compilePins(renumbered, meta))).toEqual([]);
    expect(errors(checkSymbol(renumbered, meta, opts))).toEqual([]);
  });

  it('ROTATE 90 turns the left / right pins into top / bottom pins with no phantom pin and no check error', () => {
    const { state, meta } = pushButton();
    const rotated: DrawingState = { ...state, entities: state.entities.map((e) => rotateEntity(e, { x: 0, y: 0 }, Math.PI / 2)) };
    const pins = compilePins(rotated, { ...meta, orientation: 'V' });
    expect(pins.map((p) => [p.tag, p.default, Math.round(p.point.y * 1000) / 1000])).toEqual([
      ['X2TERM01', '14', 0.375],
      ['X8TERM02', '13', -0.375],
    ]);
    const msgs = checkSymbol(rotated, { ...meta, orientation: 'V' }, opts);
    expect(errors(msgs)).toEqual([]);
    // As a horizontal symbol the same geometry is flagged: nothing connects at (+-0.375, 0).
    expect(warnings(checkSymbol(rotated, meta, opts)).some((t) => /Nothing connects/.test(t))).toBe(true);
  });

  it('uses the text digit only when no geometry is near, and a ground pin faces away from its line', () => {
    const { state, meta } = pushButton('USER_PB2', false);
    const floating = pinMarkerEntity(2, { x: 0, y: 0.3 }, 3, 'A1');
    const pins = compilePins({ ...state, entities: [...state.entities, floating] }, meta);
    const top = pins.find((p) => p.markerId === floating.id)!;
    expect(top.dir).toBe(2);
    expect(top.onEndpoint).toBe(false);
    expect(top.default).toBe('A1');
    expect(directionAt({ x: 0, y: 0 }, { x: 0, y: -1 })).toBe(2); // line goes down from the pin: wire from the top
    expect(directionAt({ x: 0, y: 0 }, { x: 1, y: 0 })).toBe(1);
    expect(directionAt({ x: -0.375, y: 0.2 }, null)).toBe(1);
    expect(directionAt({ x: 0.1, y: -0.3 }, null)).toBe(8);
  });

  it('flags duplicate pin points, wrong-side pins, markers off a line end and tag-like text', () => {
    const { state, meta } = pushButton();
    const dup = pinMarkerText('X1TERM09', { x: -0.375, y: 0 }, '21');
    const dupMsgs = checkSymbol({ ...state, entities: [...state.entities, dup] }, meta, opts);
    expect(errors(dupMsgs).some((t) => /Two pins on one point/.test(t))).toBe(true);
    // A "left" marker with no geometry at x = +0.2 is on the wrong side.
    const wrong = pinMarkerText('X1TERM05', { x: 0.2, y: 0.3 });
    const wrongMsgs = checkSymbol({ ...state, entities: [...state.entities, wrong] }, meta, opts);
    expect(errors(wrongMsgs).some((t) => /left pin but sits at/.test(t))).toBe(true);
    expect(warnings(wrongMsgs).some((t) => /not on a line end/.test(t))).toBe(true);
    // Plain "TAG1" text on layer 0 (vendor harvest) suggests the convert action.
    const vendor = checkSymbol({ ...state, entities: [...state.entities, text('TAG1', 0, 0.5)] }, meta, opts);
    expect(warnings(vendor).some((t) => /Convert selected text to attribute/.test(t))).toBe(true);
    // Geometry on another layer is an info message, a JIC name with IEC standard a warning.
    const layered = checkSymbol({ ...state, entities: [...state.entities, line(0, 0, 0, 0.1, 'MISC')] }, meta, opts);
    expect(layered.some((m) => m.level === 'info' && /layer MISC/.test(m.text))).toBe(true);
    expect(warnings(checkSymbol(state, { ...meta, name: 'HPB99_NO', standard: 'IEC' }, opts)).some((t) => /JIC library name/.test(t))).toBe(true);
    expect(warnings(checkSymbol(state, { ...meta, name: 'IEC_PB99', standard: 'JIC' }, opts)).some((t) => /IEC_/.test(t))).toBe(true);
    // A child contact whose family has no parent symbol.
    const child = checkSymbol(state, { ...meta, name: 'USER_ZZ1_NO', kind: 'child', family: 'ZZ' }, { ...opts, hasParent: () => false });
    expect(warnings(child).some((t) => /No parent \/ coil symbol of family ZZ/.test(t))).toBe(true);
    // TAG1 on top of the geometry inside the box.
    const onGeometry: DrawingState = { ...state, entities: state.entities.map((e) => (e.type === 'text' && e.text === 'TAG1' ? { ...e, position: { x: 0, y: 0 } } : e)) };
    expect(warnings(checkSymbol(onGeometry, meta, opts)).some((t) => /TAG1 at .* sits on the geometry/.test(t))).toBe(true);
    expect(summarizeCheck(dupMsgs).errors).toBeGreaterThanOrEqual(1);
    expect(summarizeCheck([{ level: 'ok', text: 'OK' }]).text).toBe('OK');
  });
});

describe('vertical symbols', () => {
  it('makes the vertical variant: geometry rotated, pins top / bottom, attributes in the vertical template, V name', () => {
    const sym = pushButton('HPB91_NO');
    const v = verticalVariant(sym);
    expect(v.meta.name).toBe('VPB91_NO');
    expect(v.meta.orientation).toBe('V');
    const pins = compilePins(v.state, v.meta);
    expect(pins.map((p) => [p.tag, p.default, Math.round(p.point.x * 1000) / 1000 + 0, Math.round(p.point.y * 1000) / 1000 + 0])).toEqual([
      ['X2TERM01', '13', 0, 0.375],
      ['X8TERM02', '14', 0, -0.375],
    ]);
    const tag1 = v.state.entities.find((e): e is TextEntity => e.type === 'text' && e.text === 'TAG1')!;
    expect(tag1.position).toEqual(attributeDefaults('TAG1', 'V').position);
    expect(tag1.align).toBe('left');
    const desc = v.state.entities.find((e): e is TextEntity => e.type === 'text' && e.text === 'DESC1')!;
    expect(desc.position).toEqual({ x: 0.45, y: -0.1 });
    expect(errors(checkSymbol(v.state, v.meta, opts))).toEqual([]);
    // marker labels already carry the new direction digit and their defaults
    const markers = v.state.entities.filter((e): e is TextEntity => e.type === 'text' && e.layer === SYMPIN_LAYER).map((t) => t.text).sort();
    expect(markers).toEqual(['X2TERM01=13', 'X8TERM02=14']);
    expect(verticalName('USER_PB1')).toBe('USER_PB1_V');
    expect(verticalName('USER_K1_NO')).toBe('USER_K1_V_NO');
    // vertical auto detection without markers: line ends at (0, +-0.375)
    const plain = defaultMeta({ name: 'USER_VLS1', family: 'LS', orientation: 'V' });
    const st: DrawingState = { ...blankSymbolState(plain), entities: [line(0, 0.375, 0, 0.125), line(0, -0.125, 0, -0.375), line(-0.1, 0.125, 0.1, -0.125), ...templatePlaceholders('standalone', 'V')] };
    expect(compilePins(st, plain).map((p) => p.tag)).toEqual(['X2TERM01', 'X8TERM02']);
    expect(errors(checkSymbol(st, plain, opts))).toEqual([]);
    // the compiled block keeps a rotated placeholder's rotation as an extra field
    const rot: DrawingState = { ...st, entities: st.entities.map((e) => (e.type === 'text' && e.text === 'TAG1' ? { ...e, rotation: Math.PI / 2 } : e)) };
    const a = compilePlaceholders(rot, plain).find((x) => x.tag === 'TAG1')!;
    expect((a as { rotation?: number }).rotation).toBeCloseTo(Math.PI / 2);
  });

  it('starts a blank symbol with the kind template at orientation-aware positions', () => {
    const h = templatePlaceholders('standalone', 'H').map((t) => [t.text, t.position.x, t.position.y]);
    expect(h).toEqual([
      ['TAG1', 0, 0.3],
      ['DESC1', 0, -0.45],
    ]);
    expect(templatePlaceholders('terminal', 'H').map((t) => t.text)).toEqual(['TERM01']);
    expect(templatePlaceholders('plc', 'V').map((t) => [t.text, t.position.x])).toEqual([
      ['TAG1', 0.45],
      ['DESC1', 0.45],
    ]);
    const meta = defaultMeta({ name: 'USER_X1', kind: 'standalone' });
    const st = blankSymbolState(meta, true);
    expect(st.entities.filter((e) => e.layer === SYMATTR_LAYER)).toHaveLength(2);
    expect(metaOf(st)?.name).toBe('USER_X1');
  });
});

describe('round trip', () => {
  it('state -> block -> state is stable over three cycles; DESC2 / DESC3 stay invisible unless placed', () => {
    let sym = pushButton('USER_RT1');
    const key = (s: SymbolState) => ({
      geometry: s.state.entities.filter((e) => e.layer === '0').length,
      placeholders: s.state.entities.filter((e) => e.layer === SYMATTR_LAYER).map((e) => (e as TextEntity).text).sort(),
      markers: s.state.entities.filter((e) => e.layer === SYMPIN_LAYER).map((e) => (e as TextEntity).text).sort(),
      pins: compilePins(s.state, s.meta).map((p) => [p.tag, p.default]),
    });
    const first = key(sym);
    for (let i = 0; i < 3; i += 1) {
      const block = symbolStateToBlock(sym.state, sym.meta);
      const t = byTag(block);
      expect(t.DESC2!.invisible).toBe(true);
      expect(t.DESC3!.invisible).toBe(true);
      expect(t.TAG1!.invisible).toBeFalsy();
      expect(block.attributes.filter((a) => !a.invisible).map((a) => a.tag).sort()).toEqual(['DESC1', 'TAG1']);
      sym = blockToSymbolState(block);
      expect(key(sym)).toEqual(first);
    }
    // A placed DESC2 stays visible.
    const withDesc2: SymbolState = { ...sym, state: { ...sym.state, entities: [...sym.state.entities, placeholderEntity('DESC2')] } };
    const b2 = byTag(symbolStateToBlock(withDesc2.state, withDesc2.meta));
    expect(b2.DESC2!.invisible).toBeFalsy();
    expect(b2.DESC3!.invisible).toBe(true);
    // The Check counts match the placeholders in the state, and the block's visible set.
    const ok = checkSymbol(sym.state, sym.meta, opts).find((m) => m.level === 'ok')!;
    expect(ok.text).toMatch(/2 wire connection\(s\), 2 visible attribute\(s\)/);
  });
});

describe('meta in the undo history', () => {
  it('Drawing.undo restores the symbol meta and the DXF writer ignores it', () => {
    const { state, meta } = pushButton('USER_UNDO1');
    const doc = new Drawing();
    doc.load(state);
    expect(metaOf(doc.snapshot)?.name).toBe('USER_UNDO1');
    doc.addEntities([line(0, 0, 0, 0.1)]);
    doc.transact((s) => withMeta(s, { ...meta, name: 'USER_UNDO2', family: 'CR', orientation: 'V' }));
    expect(metaOf(doc.snapshot)).toMatchObject({ name: 'USER_UNDO2', family: 'CR', orientation: 'V' });
    expect(doc.undo()).toBe(true);
    expect(metaOf(doc.snapshot)).toMatchObject({ name: 'USER_UNDO1', family: 'PB', orientation: 'H' });
    expect(doc.entities.filter((e) => e.type === 'line')).toHaveLength(5); // the geometry edit before the rename is untouched
    expect(doc.redo()).toBe(true);
    expect(metaOf(doc.snapshot)?.name).toBe('USER_UNDO2');
    // a pin default edit is an ordinary entity change on the undo stack
    const marker = doc.entities.find((e): e is TextEntity => e.type === 'text' && e.layer === SYMPIN_LAYER)!;
    doc.replaceEntities([{ ...marker, text: markerText(markerTag(marker.text), '21') }]);
    expect(markerDefault((doc.entity(marker.id) as TextEntity).text)).toBe('21');
    doc.undo();
    expect(markerDefault((doc.entity(marker.id) as TextEntity).text)).toBe('13');
    // meta survives ensureBlocks / layer changes and is not written to DXF
    doc.setCurrentLayer('SYMATTR');
    expect(metaOf(doc.snapshot)?.name).toBe('USER_UNDO2');
    const dxf = writeDxf(doc.snapshot);
    expect(dxf).not.toContain('USER_UNDO2');
    expect(readDxf(dxf).entities.length).toBeGreaterThan(0);
    expect(new Drawing({ meta: { name: 'X', kind: 'standalone' } }).snapshot.meta?.name).toBe('X');
    expect(metaOf(new Drawing().snapshot)).toBeNull();
  });
});

describe('attribute defaults', () => {
  it('keeps MFG / CAT / DESC / TAG1 defaults and unknown invisible vendor attributes through harvest and compile', () => {
    const vendor: BlockDef = {
      name: 'AB_800T_PB',
      description: 'Allen-Bradley push button',
      basePoint: { x: 0, y: 0 },
      entities: [line(-0.375, 0, -0.125, 0), line(0.125, 0, 0.375, 0), line(-0.125, -0.1, -0.125, 0.1), line(0.125, -0.1, 0.125, 0.1)],
      attributes: [
        attr('TAG1', 0, 0.3, { default: 'PB?' }),
        attr('DESC1', 0, -0.4, { default: 'START' }),
        attr('MFG', 0, 0.6, { invisible: true, default: 'AB' }),
        attr('CAT', 0, 0.7, { invisible: true, default: '800T-A1D' }),
        attr('X1TERM01', -0.375, 0, { invisible: true, default: '3' }),
        attr('X4TERM02', 0.375, 0, { invisible: true, default: '4' }),
        attr('VENDOR_SERIES', 0, 0.9, { invisible: true, default: '800T' }),
        attr('PLATE', 0, 1, { invisible: true }),
      ],
    };
    const state: DrawingState = { entities: [], layers: [], blocks: { AB_800T_PB: vendor }, currentLayer: '0' };
    const sym = harvestBlock(state, 'AB_800T_PB')!;
    expect(sym.meta.attrDefaults).toEqual({ TAG1: 'PB?', DESC1: 'START', MFG: 'AB', CAT: '800T-A1D', VENDOR_SERIES: '800T', PLATE: '' });
    const block = symbolStateToBlock(sym.state, { ...sym.meta, name: 'USER_AB_PB', family: 'PB' });
    const t = byTag(block);
    expect(t.TAG1!.default).toBe('PB?');
    expect(t.DESC1!.default).toBe('START');
    expect(t.MFG).toMatchObject({ default: 'AB', invisible: true });
    expect(t.CAT!.default).toBe('800T-A1D');
    expect(t.X1TERM01!.default).toBe('3');
    expect(t.VENDOR_SERIES).toMatchObject({ default: '800T', invisible: true });
    expect(t.PLATE).toMatchObject({ default: '', invisible: true });
    // Editing a default in the palette (meta) wins over the harvested one, and re-opening keeps it.
    const edited = symbolStateToBlock(sym.state, { ...sym.meta, name: 'USER_AB_PB', family: 'PB', attrDefaults: { ...sym.meta.attrDefaults, CAT: '800T-B1D', RATING1: '10A' } });
    expect(byTag(edited).CAT!.default).toBe('800T-B1D');
    expect(byTag(edited).RATING1!.default).toBe('10A');
    const back = blockToSymbolState(edited);
    expect(back.meta.attrDefaults).toMatchObject({ CAT: '800T-B1D', RATING1: '10A', MFG: 'AB', VENDOR_SERIES: '800T' });
    expect(back.state.entities.filter((e) => e.layer === SYMATTR_LAYER).map((e) => (e as TextEntity).text).sort()).toEqual(['DESC1', 'TAG1']);
    // a library symbol keeps its invisible defaults too (WDTYPE is derived, not stored)
    const lib = blockToSymbolState(findSymbol('HPB11_NO')!);
    expect(lib.meta.attrDefaults.WDTYPE).toBeUndefined();
  });
});

describe('rename flow', () => {
  it('rename moves the entry, copy keeps both, cancel aborts, an existing target is replaced', () => {
    const lib = new UserLibrary(memoryUserLibraryStore());
    const put = (name: string) => {
      const s = pushButton(name);
      lib.put({ block: symbolStateToBlock(s.state, s.meta), standard: 'JIC', category: 'Test', family: 'PB' });
    };
    put('OLD1');
    expect(applyRenameChoice('cancel', 'OLD1', 'NEW1', lib)).toBeNull();
    expect(lib.has('OLD1')).toBe(true);
    expect(applyRenameChoice('copy', 'OLD1', 'NEW1', lib)).toMatch(/kept/);
    expect(lib.has('OLD1')).toBe(true);
    expect(applyRenameChoice('rename', 'OLD1', 'NEW1', lib)).toMatch(/renamed to NEW1/);
    expect(lib.has('OLD1')).toBe(false);
    expect(lib.has('NEW1')).toBe(true);
    put('OLD2');
    expect(applyRenameChoice('rename', 'OLD2', 'NEW1', lib)).toMatch(/replaced/);
    expect(lib.has('OLD2')).toBe(false);
    expect(lib.has('NEW1')).toBe(true);
  });
});

describe('NO / NC twin', () => {
  it('swaps the name suffix, contact, pin defaults and description, and adds / removes the blade of a standard contact', () => {
    const no: SymbolState = pushButton('USER_K1_NO');
    no.meta.kind = 'child';
    no.meta.contact = 'NO';
    no.meta.description = 'Relay contact, normally open (NO)';
    const nc = createTwin(no);
    expect(nc.meta).toMatchObject({ name: 'USER_K1_NC', contact: 'NC', kind: 'child', family: 'PB' });
    expect(nc.meta.description).toBe('Relay contact, normally closed (NC)');
    const pins = compilePins(nc.state, nc.meta);
    expect(pins.map((p) => p.default)).toEqual(['11', '12']);
    // the standard two verticals at +-0.125 get the diagonal blade
    const blades = nc.state.entities.filter((e): e is LineEntity => e.type === 'line' && Math.abs(e.a.x - e.b.x) > 0.2 && Math.abs(e.a.y - e.b.y) > 0.2);
    expect(blades).toHaveLength(1);
    expect(nc.state.entities.every((e) => !no.state.entities.some((o) => o.id === e.id))).toBe(true); // fresh ids
    // and back: the blade is removed, defaults return to 13 / 14
    const back = createTwin(nc);
    expect(back.meta.name).toBe('USER_K1_NO');
    expect(back.state.entities.filter((e): e is LineEntity => e.type === 'line' && Math.abs(e.a.x - e.b.x) > 0.2 && Math.abs(e.a.y - e.b.y) > 0.2)).toHaveLength(0);
    expect(compilePins(back.state, back.meta).map((p) => p.default)).toEqual(['13', '14']);
    // standalone pilot devices without a suffix get _NC; auto pins follow the family / suffix rule
    const ls = pushButton('USER_LS1', false);
    ls.meta.family = 'LS';
    const lsNc = createTwin(ls);
    expect(lsNc.meta.name).toBe('USER_LS1_NC');
    expect(lsNc.meta.contact).toBe('NC');
    expect(compilePins(lsNc.state, lsNc.meta).map((p) => p.default)).toEqual(['11', '12']);
    expect(twinName('X_NC')).toBe('X_NO');
    expect(twinPin('13')).toBe('11');
    expect(twinPin('22')).toBe('24');
    expect(twinPin('A1')).toBe('A1');
    expect(twinDescription('Limit switch NO', 'NC')).toBe('Limit switch NC');
    expect(twinDescription('Normally closed contact', 'NO')).toBe('Normally open contact');
  });
});

describe('harvest base point and stub snapping', () => {
  it('ignores text for the centre, offers the wire-stub midpoint, and snaps stub ends after scaling', () => {
    const vendor: BlockDef = {
      name: 'VENDOR_PB',
      basePoint: { x: 0, y: 0 },
      entities: [line(0, 1, 1, 1), line(3, 1, 4, 1), line(1, 0.5, 1, 1.5), line(3, 0.5, 3, 1.5), text('800T-A1D', 2, -1)],
      attributes: [],
    };
    const lookup = () => undefined;
    // the part-number text under the symbol must not pull the centre down
    expect(resolveBasePoint('center', vendor.entities, lookup, { x: 0, y: 0 })).toEqual({ x: 2, y: 1 });
    expect(resolveBasePoint('stubs', vendor.entities, lookup, { x: 0, y: 0 })).toEqual({ x: 2, y: 1 });
    expect(resolveBasePoint('left', vendor.entities, lookup, { x: 0, y: 0 })).toEqual({ x: 0, y: 1 });
    expect(resolveBasePoint('insert', vendor.entities, lookup, { x: 9, y: 9 })).toEqual({ x: 9, y: 9 });
    // slightly crooked stubs: after scaling to 0.75 in their ends land exactly on y = 0 and x = +-0.375
    const crooked: BlockDef = { ...vendor, name: 'CROOKED', entities: [line(0, 1.05, 1, 1), line(3, 1, 4, 0.96), line(1, 0.5, 1, 1.5), line(3, 0.5, 3, 1.5)] };
    const state: DrawingState = { entities: [], layers: [], blocks: { CROOKED: crooked }, currentLayer: '0' };
    const base = resolveBasePoint('stubs', crooked.entities, lookup, crooked.basePoint);
    const sym = harvestBlock(state, 'CROOKED', { basePoint: base, scaleToWidth: 0.75 })!;
    const ends = sym.state.entities.filter((e): e is LineEntity => e.type === 'line').flatMap((l) => [l.a, l.b]);
    expect(ends.some((p) => p.x === -0.375 && p.y === 0)).toBe(true);
    expect(ends.some((p) => p.x === 0.375 && p.y === 0)).toBe(true);
    expect(compilePins(sym.state, { ...sym.meta, family: 'PB' }).map((p) => p.tag)).toEqual(['X1TERM01', 'X4TERM02']);
    expect(snapStubEndpoints([line(-0.36, 0.02, 0, 0.5)])[0]).toMatchObject({ a: { x: -0.375, y: 0 }, b: { x: 0, y: 0.5 } });
  });
});

describe('placement', () => {
  it('Place / Add pin round the picked point to the snap grid of the symbol tab', () => {
    const ctx = fakeContext(new Drawing());
    ctx.snap.gridSize = 0.0625;
    const placed: Array<{ x: number; y: number }> = [];
    const tool = new PlaceEntityTool('AESYMATTR', 'pick', (p) => placeholderEntity('TAG1', p), (p) => placed.push(p), true);
    drive(tool, ctx, [{ move: { x: 0.01, y: -0.3546 } }, { x: 0.01, y: -0.3546 }]);
    expect(placed).toEqual([{ x: 0, y: -0.375 }]);
    expect(ctx.finished).toBe(true);
    // without the flag (ordinary drawings) the point is taken as picked
    const raw: Array<{ x: number; y: number }> = [];
    drive(new PlaceEntityTool('AESYMATTR', 'pick', (p) => placeholderEntity('TAG1', p), (p) => raw.push(p)), ctx, [{ x: 0.01, y: -0.3546 }]);
    expect(raw).toEqual([{ x: 0.01, y: -0.3546 }]);
  });
});

describe('names', () => {
  it('replaces whitespace with _ and Check refuses names with spaces', () => {
    expect(normalizeSymbolName('my relay 1')).toBe('MY_RELAY_1');
    expect(normalizeSymbolName('  a\tb ')).toBe('_A_B_');
    const { state, meta } = pushButton();
    expect(errors(checkSymbol(state, { ...meta, name: 'MY RELAY' }, opts)).some((t) => /whitespace/.test(t))).toBe(true);
    expect(errors(checkSymbol(state, { ...meta, name: 'MY_RELAY' }, opts))).toEqual([]);
  });
});
