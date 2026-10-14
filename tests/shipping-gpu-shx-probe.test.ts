/**
 * Pure fixed SHX DXF/semantic/stamp guards; native/browser execution is validated separately.
 * Electron and glyph metrics below are explicit mock-only doubles. These tests
 * contain no installed SHX programs and provide no native/GPU accuracy evidence.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readDxf, writeDxf } from '../src/io/dxf';
import { Drawing, type DrawingState, type DrawingHistory } from '../src/core/document';
import { translateEntity, type TextEntity } from '../src/core/entities';
import { metricTextPlacement, type TextGeometryContext, type TextMetricStyle } from '../src/core/text-metrics';
import { textStylesOf, type TextStyle } from '../src/io/encoding';
import { PNG } from 'pngjs';
import { classifyShippingShxAdapter, compareShippingShxPair, SHX_COMPARISON_LABELS, type ShxPair } from '../scripts/shipping-gpu-shx-smoke.mjs';

// Resolve the fixture from the repository root without a cwd assumption.
const repoRoot = new URL('../', import.meta.url);
const fixtureBytes = readFileSync(new URL('tests/fixtures/interchange/r2018-shx-text.dxf', repoRoot));
const fixture = fixtureBytes.toString('utf8');
const sourceFile = fileURLToPath(new URL('../electron/main/shipping-gpu-shx-probe.cjs', import.meta.url));
const source = readFileSync(sourceFile, 'utf8');
const originalRequire = createRequire(sourceFile);

interface SemanticRow {
  text: string;
  style: string | null;
  align: string;
  justification: { horizontal: number; vertical: number } | null;
  position: { x: number; y: number };
  firstAlignmentPoint: { x: number; y: number } | null;
  alignmentPoint: { x: number; y: number } | null;
  height: number;
  rotation: number;
  widthFactor: number | null;
  oblique: number | null;
  layer: string;
  color: number | string;
  trueColor: number | null;
  colorName: string | null;
  transparency: number | null;
  linetype: string;
  lineWeight: number | null;
  ltscale: number;
  field: unknown;
}
interface SemanticStyle {
  key: string;
  name: string;
  font: string;
  bigFont: string | null;
  flags: number | null;
  height: number;
  widthFactor: number;
  oblique: number;
  generation: number | null;
  family: string | null;
  bold: boolean | null;
  italic: boolean | null;
}
interface Semantic { rows: SemanticRow[]; styles: SemanticStyle[] }
interface FixedFont {
  name: string;
  bytes: number;
  sha256: string;
  above: number;
  below: number;
  oracle: { right: number; middle: number; fitted: number; box: number[] };
}
interface ExportFont extends FixedFont { path: string; resourceId: string }
interface StampEditor {
  doc: Pick<Drawing, 'snapshot' | 'revision' | 'dirty' | 'filePath' | 'history'>;
  selection: Set<string>;
  viewport: {
    center: { x: number; y: number };
    scale: number;
    twist: number;
    width: number; height: number; dpr: number;
    canvas: { width: number; height: number };
    settings: { background: string; gridVisible: boolean };
  };
}
interface Stamp {
  state: DrawingState;
  revision: number;
  dirty: boolean;
  binding: string | null;
  undo: DrawingHistory['undo'];
  redo: DrawingHistory['redo'];
  selection: string[];
  view: string;
}
interface Probe {
  SHX_FIXTURE_SHA256: string;
  SHX_FIXTURE_BYTES: number;
  SHX_FONTS: readonly FixedFont[];
  shippingShxSemantic(state: DrawingState): Semantic;
  shippingShxAssertFixture(semantic: Semantic): void;
  shippingShxAssertSemantic(actual: unknown, expected: unknown, tolerance?: number): void;
  shippingShxStamp(editor: StampEditor): Stamp;
  shippingShxSameStamp(editor: StampEditor, before: Stamp): boolean;
  shippingShxExportCheck(bytes: Buffer, fonts: readonly ExportFont[]): {
    textCount: number; explicitDefaults: boolean; runtimeProgramsAbsent: boolean;
  };
  shippingShxObservedFrame(control: {
    resetCounts(): void; render(): boolean; counts(): ShxPair['glCalls'];
  }): { rendered: boolean; canvasCalls(): ShxPair['glCalls'] };
  runShippingGpuShxProbe(ctx: unknown, testBuild: boolean, overlay: () => unknown): Promise<unknown>;
}

function loadProbe() {
  // Only Electron is doubled. All pure helpers are evaluated from the current module text.
  const app = { getPath: vi.fn(() => { throw new Error('Mock-only Electron profile is unavailable'); }) };
  const dialog = { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() };
  const module = { exports: {} as Probe };
  new Function('require', 'module', source)(
    (name: string) => name === 'electron' ? { app, dialog } : originalRequire(name),
    module,
  );
  return { probe: module.exports, app, dialog };
}
const { probe } = loadProbe();
const readFixture = () => readDxf(fixture);
const copySemantic = (value: Semantic): Semantic => JSON.parse(JSON.stringify(value)) as Semantic;
const textRows = (state: DrawingState) => state.entities.filter((entity): entity is TextEntity => entity.type === 'text');
const semantic = (doc: Drawing) => probe.shippingShxSemantic(doc.snapshot);
const exportFonts: ExportFont[] = probe.SHX_FONTS.map((font, index) => {
  const path = 'C:\\mock-only-shx-programs\\' + font.name;
  return { ...font, path, resourceId: JSON.stringify([path, 'mock-only-resource-' + index]) };
});

/** Deliberately invented metrics exercise plumbing; they are not the recorded native oracle. */
function mockOnlyGeometryProvider() {
  const contexts = new WeakMap<Readonly<Record<string, TextStyle>>, TextGeometryContext>();
  const catalog: Record<string, { right: number; middleAdvance: number; fittedAdvance: number }> = {
    'txt.shx': { right: 24, middleAdvance: 32, fittedAdvance: 40 },
    'simplex.shx': { right: 36, middleAdvance: 50, fittedAdvance: 50 },
    'romans.shx': { right: 28, middleAdvance: 36, fittedAdvance: 44 },
    'romant.shx': { right: 30, middleAdvance: 38, fittedAdvance: 46 },
  };
  return (styles: Readonly<Record<string, TextStyle>>): TextGeometryContext => {
    const prior = contexts.get(styles);
    if (prior) return prior;
    const context: TextGeometryContext = {
      cacheKey: {},
      resolve(input: TextMetricStyle) {
        const style = styles[input.style ?? 'Standard'];
        const font = style?.font || 'txt.shx';
        return {
          kind: 'stroke',
          widthFactor: input.widthFactor ?? style?.widthFactor ?? 1,
          oblique: input.oblique ?? (style?.oblique ?? 0) * Math.PI / 180,
          ...(catalog[font] ? { shxResourceId: 'mock-only:' + font } : {}),
        };
      },
      shxRun(text, height, face) {
        const name = face.kind === 'stroke' ? face.shxResourceId?.slice('mock-only:'.length) : undefined;
        const font = name ? catalog[name] : undefined;
        if (!font) return { ok: false, problem: 'No mock-only metric program' };
        const scale = height / 10;
        const advance = text === ' A ' ? font.middleAdvance : text === 'A ' ? font.fittedAdvance : font.right + 6;
        const right = text === 'AVATAR' ? font.right : advance - 6;
        return {
          ok: true, advance: advance * scale, left: 2 * scale, right: right * scale,
          ascent: 8 * scale, descent: 2 * scale, terminalSpace: text.endsWith(' '),
          segments: [{ kind: 'line', from: [0, 0] as const, to: [right * scale, 8 * scale] as const }],
        };
      },
      measure(text, height, face) {
        const run = context.shxRun!(text, height, face);
        if (!run?.ok) throw new Error('Tests must use an explicitly bound mock-only program');
        return { advance: run.advance, left: run.left, right: run.right, ascent: run.ascent, descent: run.descent };
      },
    };
    contexts.set(styles, context);
    return context;
  };
}
function mockDocument() { return new Drawing(readFixture(), mockOnlyGeometryProvider()); }
function resourceId(context: TextGeometryContext, input: TextMetricStyle) {
  const face = context.resolve(input); return face.kind === 'stroke' ? face.shxResourceId : undefined;
}
function editorWithHistory() {
  const doc = mockDocument();
  doc.filePath = 'C:\\mock-only-drawings\\fixture.dxf';
  doc.replaceEntities([translateEntity(doc.entities[2] as TextEntity, { x: 1, y: 2 })]);
  doc.replaceEntities([translateEntity(doc.entities[4] as TextEntity, { x: 2, y: 3 })]);
  expect(doc.undo()).toBe(true);
  const ed: StampEditor = {
    doc, selection: new Set(['mock-selection-a', 'mock-selection-b']),
    viewport: { center: { x: 340, y: 550 }, scale: 2, twist: 0, width: 800, height: 600, dpr: 1.25,
      canvas: { width: 1000, height: 750 }, settings: { background: '#212830', gridVisible: false } },
  };
  return { doc, ed };
}
function switchTxtStyle(doc: Drawing) {
  doc.transactDrawing(state => {
    const styles = textStylesOf(state);
    return { ...state, meta: { ...state.meta, textStyles: {
      ...styles, JCAD_SHX_TXT: { ...styles.JCAD_SHX_TXT!, font: 'simplex.shx' },
    } } };
  });
}
function rewriteFirstText(text: string, change: (pairs: Array<[string, string]>) => Array<[string, string]>): Buffer {
  const lines = text.split(/\r?\n/);
  let start = -1, end = lines.length - 1;
  for (let at = 0; at + 1 < lines.length; at += 2) {
    if (Number(lines[at]) !== 0) continue;
    if (start >= 0) { end = at; break; }
    if (lines[at + 1] === 'TEXT') start = at;
  }
  if (start < 0) throw new Error('Expected a real writer TEXT record');
  const pairs: Array<[string, string]> = [];
  for (let at = start; at < end; at += 2) pairs.push([lines[at]!, lines[at + 1]!]);
  lines.splice(start, end - start, ...change(pairs).flat());
  return Buffer.from(lines.join('\r\n'));
}

describe('private fixed SHX synthetic DXF semantics', () => {
  it('pins the committed synthetic fixture and exactly its four named private resource descriptors', () => {
    expect(fixtureBytes.length).toBe(probe.SHX_FIXTURE_BYTES);
    expect(createHash('sha256').update(fixtureBytes).digest('hex')).toBe(probe.SHX_FIXTURE_SHA256);
    expect(probe.SHX_FONTS.map(font => font.name)).toEqual(['txt.shx', 'simplex.shx', 'romans.shx', 'romant.shx']);
    expect(probe.SHX_FONTS).toHaveLength(4);
    for (const font of probe.SHX_FONTS) {
      expect(font.bytes).toBeGreaterThan(0);
      expect(font.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(() => probe.shippingShxAssertFixture(probe.shippingShxSemantic(readFixture()))).not.toThrow();
  });

  it('retains all twenty native strings, entity defaults and anchors independently of CUSTOM STYLE defaults', () => {
    const state = readFixture(), rows = textRows(state), styles = textStylesOf(state);
    const middleX = [105, 285.7142857142857, 465.7142857142857, 645.2380952380951];
    const rightX = [60, 243.8095238095238, 429.5238095238095, 602.8571428571429];
    const fitWidths = [5, 5.121951219512195, 5.384615384615385, 5.121951219512196];
    expect(rows).toHaveLength(20);
    for (let font = 0; font < 4; font++) {
      const base = 20 + 180 * font, anchor = base + 100, ordinal = font * 5;
      const controls = rows[ordinal]!, custom = rows[ordinal + 1]!, middle = rows[ordinal + 2]!;
      const fitted = rows[ordinal + 3]!, right = rows[ordinal + 4]!;
      expect([controls.text, custom.text, middle.text, fitted.text, right.text]).toEqual(['%%c10 %%d %%p', 'Ag', ' A ', 'A ', 'AVATAR']);
      expect(controls.position).toEqual({ x: base, y: 344 });
      expect(custom).toMatchObject({ position: { x: base, y: 740 }, widthFactor: 1, oblique: 0 });
      expect(styles[custom.style!]!).toMatchObject({ widthFactor: 0.8, oblique: 10 });
      expect(middle).toMatchObject({
        align: 'center', justification: { horizontal: 4, vertical: 0 },
        position: { x: anchor, y: 434 }, firstAlignmentPoint: { x: middleX[font], y: 429 },
        alignmentPoint: { x: anchor, y: 434 },
      });
      expect(fitted).toMatchObject({
        align: 'left', justification: { horizontal: 5, vertical: 0 },
        position: { x: base, y: 596 }, alignmentPoint: { x: anchor, y: 596 }, widthFactor: fitWidths[font],
      });
      expect(fitted.firstAlignmentPoint).toBeUndefined();
      expect(right).toMatchObject({
        align: 'right', justification: { horizontal: 2, vertical: 0 },
        position: { x: anchor, y: 452 }, firstAlignmentPoint: { x: rightX[font], y: 452 },
        alignmentPoint: { x: anchor, y: 452 },
      });
      for (const row of rows.slice(ordinal, ordinal + 5)) expect(row).toMatchObject({ height: 10, rotation: 0, oblique: 0, layer: '0', color: 7 });
    }
  });

  it('excludes regenerated ids/handles/runtime authority and makes STYLE map insertion order irrelevant', () => {
    const state = readFixture(), wanted = probe.shippingShxSemantic(state);
    const styles = Object.fromEntries(Object.entries(textStylesOf(state)).reverse());
    const altered = { ...state, entities: state.entities.map((entity, index) => ({
      ...entity, id: 'mock-regenerated-' + index, cadIdentity: 'mock-handle-' + index,
      shxResourceId: 'mock-only-resource', resolvedFontPath: 'C:\\mock-only-shx-programs\\txt.shx',
    })), meta: { ...state.meta, textStyles: styles } };
    expect(probe.shippingShxSemantic(altered)).toEqual(wanted);
    expect(JSON.stringify(wanted)).not.toContain('mock-only-resource');
    expect(wanted.styles.map(style => style.key)).toEqual(wanted.styles.map(style => style.key).sort());
  });

  it.each(['missing row', 'extra row', 'non-TEXT', 'missing STYLE'] as const)('rejects %s before accepting a semantic stamp', damage => {
    const state = readFixture();
    if (damage === 'missing row') expect(() => probe.shippingShxSemantic({ ...state, entities: state.entities.slice(1) })).toThrow(/twenty/);
    else if (damage === 'extra row') expect(() => probe.shippingShxSemantic({ ...state, entities: [...state.entities, state.entities[0]!] })).toThrow(/twenty/);
    else if (damage === 'non-TEXT') {
      const line = { id: 'mock-line', type: 'line' as const, layer: '0', color: 7, a: { x: 0, y: 0 }, b: { x: 1, y: 1 } };
      expect(() => probe.shippingShxSemantic({ ...state, entities: [line, ...state.entities.slice(1)] })).toThrow(/twenty/);
    } else {
      const styles = { ...textStylesOf(state) }; delete styles.Standard;
      expect(() => probe.shippingShxSemantic({ ...state, meta: { ...state.meta, textStyles: styles } })).toThrow(/nine/);
    }
  });

  it.each(['trimmed spaces', 'entity width inheritance', 'moved first anchor', 'wrong STYLE font'] as const)('rejects a count-correct but changed fixed fixture: %s', damage => {
    const value = probe.shippingShxSemantic(readFixture());
    if (damage === 'trimmed spaces') value.rows[2]!.text = 'A';
    else if (damage === 'entity width inheritance') value.rows[1]!.widthFactor = 0.8;
    else if (damage === 'moved first anchor') value.rows[2]!.firstAlignmentPoint!.x += 1;
    else value.styles.find(style => style.name === 'JCAD_SHX_TXT')!.font = 'simplex.shx';
    expect(() => probe.shippingShxAssertFixture(value)).toThrow();
  });

  it('uses persistence quantum for repeated real exports while permitting regenerated ids', () => {
    let state = readFixture();
    const wanted = probe.shippingShxSemantic(state), originalIds = state.entities.map(entity => entity.id);
    for (let round = 0; round < 3; round++) {
      state = readDxf(writeDxf(state));
      expect(() => probe.shippingShxAssertSemantic(probe.shippingShxSemantic(state), wanted)).not.toThrow();
      expect(state.entities.map(entity => entity.id)).not.toEqual(originalIds);
    }
  });

  it('keeps exact strings and structure while separating writer rounding from native placement tolerance', () => {
    const wanted = probe.shippingShxSemantic(readFixture());
    const rounded = copySemantic(wanted); rounded.rows[0]!.height += 5e-11;
    expect(() => probe.shippingShxAssertSemantic(rounded, wanted)).not.toThrow();
    expect(() => probe.shippingShxAssertSemantic(rounded, wanted, 0)).toThrow(/numeric/);
    const tooFar = copySemantic(wanted); tooFar.rows[0]!.height += 1e-8;
    expect(() => probe.shippingShxAssertSemantic(tooFar, wanted)).toThrow(/numeric/);
    const trimmed = copySemantic(wanted); trimmed.rows[3]!.text = 'A';
    expect(() => probe.shippingShxAssertSemantic(trimmed, wanted)).toThrow(/exact/);
    const missing = copySemantic(wanted) as unknown as { rows: Array<Record<string, unknown>>; styles: SemanticStyle[] };
    delete missing.rows[0]!.oblique;
    expect(() => probe.shippingShxAssertSemantic(missing, wanted)).toThrow(/key|missing/);
    const infinite = copySemantic(wanted); infinite.rows[0]!.height = Infinity;
    expect(() => probe.shippingShxAssertSemantic(infinite, wanted)).toThrow(/numeric/);
  });
});

describe('real Drawing edits and placement with explicitly mock-only glyph metrics', () => {
  it('switches only the normal TXT STYLE, derives current FIT width, and restores matching programs on undo/redo', () => {
    const doc = mockDocument(), baseline = semantic(doc), initialContext = doc.lookupBlock.textGeometry!;
    const fit = doc.entities[3] as TextEntity, right = doc.entities[4] as TextEntity;
    expect(metricTextPlacement(fit, initialContext).text.widthFactor).toBe(2.5);
    expect(metricTextPlacement(right, initialContext).offset).toBe(-24);
    const generationIndependentIds = doc.entities.map(entity => entity.id);
    switchTxtStyle(doc);
    const changed = semantic(doc), expected = copySemantic(baseline);
    expected.styles.find(style => style.name === 'JCAD_SHX_TXT')!.font = 'simplex.shx';
    expect(() => probe.shippingShxAssertSemantic(changed, expected, 0)).not.toThrow();
    expect(changed.rows).toEqual(baseline.rows);
    expect(doc.entities.map(entity => entity.id)).toEqual(generationIndependentIds);
    expect(doc.dirty).toBe(true);
    const current = doc.lookupBlock.textGeometry!;
    expect(current.cacheKey).not.toBe(initialContext.cacheKey);
    expect(resourceId(current, doc.entities[4] as TextEntity)).toBe('mock-only:simplex.shx');
    expect(resourceId(current, doc.entities[1] as TextEntity)).toBe('mock-only:txt.shx');
    expect(current.resolve(doc.entities[1] as TextEntity)).toMatchObject({ widthFactor: 1, oblique: 0 });
    expect(metricTextPlacement(fit, current).text.widthFactor).toBe(2);
    expect(fit.widthFactor).toBe(5);
    expect(metricTextPlacement(right, current).offset).toBe(-36);
    const middle = metricTextPlacement(doc.entities[2] as TextEntity, current);
    expect(middle.text.position).toEqual({ x: 120, y: 431 });
    expect(middle.offset).toBe(-25);
    expect(middle.text.position.x + middle.offset * middle.text.widthFactor!).toBe(95);
    expect((doc.entities[2] as TextEntity).firstAlignmentPoint).toEqual({ x: 105, y: 429 });
    expect(doc.undo()).toBe(true);
    expect(() => probe.shippingShxAssertSemantic(semantic(doc), baseline, 0)).not.toThrow();
    expect(doc.lookupBlock.textGeometry).toBe(initialContext);
    expect(metricTextPlacement(fit, doc.lookupBlock.textGeometry!).text.widthFactor).toBe(2.5);
    expect(doc.redo()).toBe(true);
    expect(() => probe.shippingShxAssertSemantic(semantic(doc), changed, 0)).not.toThrow();
    expect(metricTextPlacement(fit, doc.lookupBlock.textGeometry!).text.widthFactor).toBe(2);
  });

  it('translates all native anchors, undoes/redoes them, and preserves raw FIT width through two real saves', () => {
    const doc = mockDocument(); switchTxtStyle(doc);
    const original = doc.entities[2] as TextEntity, beforeMove = semantic(doc);
    doc.replaceEntities([translateEntity(original, { x: 3, y: 4 })]);
    const edited = semantic(doc), moved = doc.entity(original.id) as TextEntity;
    expect(moved.position).toEqual({ x: 123, y: 438 });
    expect(moved.firstAlignmentPoint).toEqual({ x: 108, y: 433 });
    expect(moved.alignmentPoint).toEqual({ x: 123, y: 438 });
    expect(doc.undo()).toBe(true);
    expect(() => probe.shippingShxAssertSemantic(semantic(doc), beforeMove, 0)).not.toThrow();
    expect(doc.redo()).toBe(true);
    expect(() => probe.shippingShxAssertSemantic(semantic(doc), edited, 0)).not.toThrow();
    const firstBytes = Buffer.from(writeDxf(doc.snapshot)), first = readDxf(firstBytes.toString('utf8'));
    expect(() => probe.shippingShxAssertSemantic(probe.shippingShxSemantic(first), edited)).not.toThrow();
    expect(textRows(first)[3]!.widthFactor).toBe(5);
    expect(textStylesOf(first).JCAD_SHX_TXT!.font).toBe('simplex.shx');
    const freshUnbound = new Drawing(first);
    expect(resourceId(freshUnbound.lookupBlock.textGeometry!, freshUnbound.entities[3] as TextEntity)).toBeUndefined();
    const reopened = new Drawing(first, mockOnlyGeometryProvider());
    expect(reopened.dirty).toBe(false);
    expect(reopened.history()).toEqual({ undo: [], redo: [] });
    expect(metricTextPlacement(reopened.entities[3] as TextEntity, reopened.lookupBlock.textGeometry!).text.widthFactor).toBe(2);
    const secondBytes = Buffer.from(writeDxf(reopened.snapshot)), second = readDxf(secondBytes.toString('utf8'));
    expect(() => probe.shippingShxAssertSemantic(probe.shippingShxSemantic(second), edited)).not.toThrow();
    expect(probe.shippingShxExportCheck(firstBytes, exportFonts)).toMatchObject({ textCount: 20, explicitDefaults: true });
    expect(probe.shippingShxExportCheck(secondBytes, exportFonts)).toMatchObject({ textCount: 20, explicitDefaults: true });
  });
});

describe('private SHX saved-file authority and explicit-default guards', () => {
  it('accepts actual writer output with canonical 41/51 on every TEXT', () => {
    const saved = Buffer.from(writeDxf(readFixture()));
    expect(probe.shippingShxExportCheck(saved, exportFonts)).toEqual({ textCount: 20, explicitDefaults: true, runtimeProgramsAbsent: true });
    // Native fixture intentionally omits entity defaults; the first JCad export adds them.
    expect(() => probe.shippingShxExportCheck(fixtureBytes, exportFonts)).toThrow(/explicit width\/oblique/);
  });

  it.each(['missing width', 'duplicate oblique', 'missing TEXT'] as const)('rejects %s independently of semantic renderer claims', damage => {
    const saved = writeDxf(readFixture());
    const changed = rewriteFirstText(saved, pairs => {
      if (damage === 'missing width') return pairs.filter(([code]) => Number(code) !== 41);
      if (damage === 'duplicate oblique') return [...pairs, ['51', '0']];
      return [['0', 'LINE'], ...pairs.slice(1)];
    });
    expect(() => probe.shippingShxExportCheck(changed, exportFonts)).toThrow(/twenty TEXTs/);
  });

  it.each([
    'shxResourceId', 'resourceId', 'FontFile',
    exportFonts[0]!.path, exportFonts[0]!.path.replace(/\\/g, '/'), exportFonts[0]!.resourceId,
  ])('rejects leaked mock runtime authority marker %s', marker => {
    const saved = writeDxf(readFixture()).replace('0\r\nEOF\r\n', '999\r\n' + marker + '\r\n0\r\nEOF\r\n');
    expect(() => probe.shippingShxExportCheck(Buffer.from(saved), exportFonts)).toThrow(/authority leaked/);
  });

  it('rejects empty, non-buffer and oversized exports before parsing', () => {
    expect(() => probe.shippingShxExportCheck(Buffer.alloc(0), exportFonts)).toThrow(/byte budget/);
    expect(() => probe.shippingShxExportCheck('mock-only' as unknown as Buffer, exportFonts)).toThrow(/byte budget/);
    expect(() => probe.shippingShxExportCheck(Buffer.alloc(4 * 1024 * 1024 + 1), exportFonts)).toThrow(/byte budget/);
  });
});

describe('fixed resource settlement frame counters with mock-only GL calls', () => {
  const counter = () => ({ draws: 0, uploads: 0, clear: 0, uploadBytes: 0 });
  const reset = (calls: ShxPair['glCalls']) => {
    calls.draws = 0; calls.uploads = 0; calls.clear = 0; calls.uploadBytes = 0;
  };

  it('allows an eligible unbound GPU frame before the first loaded zero-GL Canvas frame through serialized fixed helper code', () => {
    // This is the actual helper's toString transport, with no module dependency or renderer global.
    const observe = new Function('return (' + probe.shippingShxObservedFrame.toString() + ');')() as Probe['shippingShxObservedFrame'];
    const calls = counter();
    const unbound = observe({ resetCounts: () => reset(calls), counts: () => calls, render: () => {
      calls.draws = 2; calls.uploads = 1; calls.clear = 1; calls.uploadBytes = 168; return true;
    } });
    expect(unbound.rendered).toBe(true); expect(calls.draws).toBe(2);
    const loaded = observe({ resetCounts: () => reset(calls), counts: () => calls, render: () => false });
    expect(loaded.rendered).toBe(false);
    expect(loaded.canvasCalls()).toEqual(counter());
    // The earlier frame was eligible GPU; its own draw evidence is still retained.
    expect(() => unbound.canvasCalls()).toThrow(/loaded Canvas frame submitted GPU work/);
  });

  it('rejects a loaded-frame draw even if another frame or callback subsequently clears the live counters', () => {
    const calls = counter();
    const loaded = probe.shippingShxObservedFrame({ resetCounts: () => reset(calls), counts: () => calls, render: () => {
      calls.draws++; return false;
    } });
    expect(loaded.rendered).toBe(false); reset(calls);
    expect(() => loaded.canvasCalls()).toThrow(/loaded Canvas frame submitted GPU work: draws/);
  });

  it('rejects post-scene GPU work before loaded Canvas capture instead of relying only on the base-scene snapshot', () => {
    const calls = counter();
    const loaded = probe.shippingShxObservedFrame({ resetCounts: () => reset(calls), counts: () => calls, render: () => false });
    calls.draws++;
    expect(() => loaded.canvasCalls()).toThrow(/loaded Canvas frame submitted GPU work: draws/);
  });
});
describe('private SHX load/render stamp controls with real Drawing history', () => {
  it('accepts fresh history arrays only when every snapshot identity and editor field is unchanged', () => {
    const { doc, ed } = editorWithHistory(), before = probe.shippingShxStamp(ed);
    expect(before.undo).toHaveLength(1); expect(before.redo).toHaveLength(1);
    expect(doc.history().undo).not.toBe(before.undo);
    expect(probe.shippingShxSameStamp(ed, before)).toBe(true);
    // Pure placement does not enter immutable drawing state or history.
    metricTextPlacement(doc.entities[3] as TextEntity, doc.lookupBlock.textGeometry!);
    expect(probe.shippingShxSameStamp(ed, before)).toBe(true);
  });

  it.each(['undo', 'redo'] as const)('rejects replaced %s history item even when lengths, current snapshot and revision are unchanged', stack => {
    const { doc, ed } = editorWithHistory(), before = probe.shippingShxStamp(ed), history = doc.history();
    const replacement = new Drawing(readFixture()).snapshot;
    doc.restoreHistory({ ...history, [stack]: [replacement] });
    expect(doc.snapshot).toBe(before.state);
    expect(doc.revision).toBe(before.revision);
    expect(doc.history()[stack]).toHaveLength(before[stack].length);
    expect(probe.shippingShxSameStamp(ed, before)).toBe(false);
  });

  it.each(['dirty', 'file binding', 'selection membership', 'selection order', 'center', 'scale', 'twist', 'background', 'grid'] as const)('rejects changed %s despite unchanged drawing snapshot', field => {
    const { ed } = editorWithHistory(), before = probe.shippingShxStamp(ed);
    if (field === 'dirty') ed.doc.dirty = !ed.doc.dirty;
    else if (field === 'file binding') ed.doc.filePath = 'C:\\mock-only-drawings\\other.dxf';
    else if (field === 'selection membership') ed.selection = new Set(['mock-selection-a', 'different-mock-selection']);
    else if (field === 'selection order') ed.selection = new Set([...ed.selection].reverse());
    else if (field === 'center') ed.viewport.center = { ...ed.viewport.center, x: 341 };
    else if (field === 'scale') ed.viewport.scale += 1;
    else if (field === 'twist') ed.viewport.twist += 0.1;
    else if (field === 'background') ed.viewport.settings.background = '#000000';
    else ed.viewport.settings.gridVisible = true;
    expect(ed.doc.snapshot).toBe(before.state);
    expect(probe.shippingShxSameStamp(ed, before)).toBe(false);
  });

  it.each(['logical width', 'logical height', 'DPR', 'backing width', 'backing height'] as const)('rejects changed %s during resource-only settlement with drawing/history unchanged', dimension => {
    const { doc, ed } = editorWithHistory(), before = probe.shippingShxStamp(ed);
    if (dimension === 'logical width') ed.viewport.width += 1;
    else if (dimension === 'logical height') ed.viewport.height += 1;
    else if (dimension === 'DPR') ed.viewport.dpr += 0.25;
    else if (dimension === 'backing width') ed.viewport.canvas.width += 1;
    else ed.viewport.canvas.height += 1;
    expect(doc.snapshot).toBe(before.state); expect(doc.revision).toBe(before.revision);
    expect(doc.dirty).toBe(before.dirty); expect(doc.filePath).toBe(before.binding);
    expect(doc.history()).toEqual({ undo: before.undo, redo: before.redo });
    expect(probe.shippingShxSameStamp(ed, before)).toBe(false);
  });
  it('rejects a changed revision or semantically equivalent replacement snapshot', () => {
    const { doc, ed } = editorWithHistory(), before = probe.shippingShxStamp(ed);
    const revisionOnly = { ...ed, doc: {
      snapshot: doc.snapshot, revision: doc.revision + 1, dirty: doc.dirty, filePath: doc.filePath, history: () => doc.history(),
    } };
    expect(probe.shippingShxSameStamp(revisionOnly, before)).toBe(false);
    const equivalent = new Drawing({ ...doc.snapshot, entities: doc.entities.map(entity => ({ ...entity })) }).snapshot;
    expect(() => probe.shippingShxAssertSemantic(probe.shippingShxSemantic(equivalent), semantic(doc), 0)).not.toThrow();
    expect(probe.shippingShxSameStamp({ ...ed, doc: {
      snapshot: equivalent, revision: doc.revision, dirty: doc.dirty, filePath: doc.filePath, history: () => doc.history(),
    } }, before)).toBe(false);
  });

  it('rejects a development build before any doubled Electron profile or renderer call', async () => {
    const loaded = loadProbe(), executeJavaScript = vi.fn();
    const ctx = { mainWindow: { isDestroyed: () => false, webContents: { executeJavaScript } } };
    await expect(loaded.probe.runShippingGpuShxProbe(ctx, true, () => ({}))).rejects.toThrow(/ordinary shipping entry/);
    expect(loaded.app.getPath).not.toHaveBeenCalled();
    expect(executeJavaScript).not.toHaveBeenCalled();
    expect(loaded.dialog.showOpenDialog).not.toHaveBeenCalled();
    expect(loaded.dialog.showSaveDialog).not.toHaveBeenCalled();
  });
});

/** Mock pixels only: policy regressions do not certify glyph shape, native rendering or a device. */
function mockPng(change?: (image: PNG) => void): string {
  const image = new PNG({ width: 64, height: 64 });
  for (let at = 0; at < image.data.length; at += 4) image.data.set([33, 40, 48, 255], at);
  for (let y = 12; y < 20; y++) for (let x = 12; x < 20; x++) image.data.set([255, 255, 255, 255], (y * 64 + x) * 4);
  change?.(image);
  return 'data:image/png;base64,' + PNG.sync.write(image).toString('base64');
}
function mockPair(renderer: 'canvas' | 'gpu' = 'canvas'): ShxPair {
  const png = mockPng();
  return {
    label: renderer === 'canvas' ? 'loaded-warm' : 'unbound-before-load', renderer,
    referencePng: png, actualPng: png, documentUnchanged: true,
    glCalls: renderer === 'canvas' ? { draws: 0, uploads: 0, clear: 0, uploadBytes: 0 } : { draws: 1, uploads: 1, clear: 1, uploadBytes: 16 },
  };
}

describe('private SHX raster and adapter policy using mock-only pixels', () => {
  it('keeps twenty-six unique fixed comparison labels with load transitions constrained to Canvas', () => {
    expect(SHX_COMPARISON_LABELS).toHaveLength(26);
    expect(new Set(SHX_COMPARISON_LABELS.map(([label]) => label)).size).toBe(26);
    expect(SHX_COMPARISON_LABELS.filter(([label]) => label.includes('-load-'))).toHaveLength(12);
    for (const [label, expected] of SHX_COMPARISON_LABELS) if (label.includes('-load-')) expect(expected).toBe('canvas');
  });

  it.each(['Software', 'SwiftShader', 'WARP', 'Microsoft Basic Render', 'llvmpipe', 'softpipe', 'lavapipe'])('gives %s software identity precedence over Intel/NVIDIA model substrings', marker => {
    expect(classifyShippingShxAdapter({
      vendor: marker, renderer: 'mock-only renderer', unmaskedVendor: 'NVIDIA', unmaskedRenderer: 'Intel UHD RTX mock-only',
    })).toBe('software');
  });

  it('requires unmasked vendor evidence for hardware classification', () => {
    expect(classifyShippingShxAdapter(null)).toBe('not-created');
    expect(classifyShippingShxAdapter({ vendor: 'NVIDIA', renderer: 'Intel UHD' })).toBe('unknown-or-other');
    expect(classifyShippingShxAdapter({ unmaskedVendor: 'Intel', unmaskedRenderer: 'mock-only UHD' })).toBe('intel');
    expect(classifyShippingShxAdapter({ unmaskedVendor: 'NVIDIA', unmaskedRenderer: 'mock-only RTX' })).toBe('nvidia');
  });

  it('rejects unknown labels and forbidden renderer choices before decoding invalid PNG strings', () => {
    const unknown = { ...mockPair(), label: 'supplied-new-label', referencePng: 'invalid', actualPng: 'invalid' };
    expect(() => compareShippingShxPair(unknown)).toThrow(/Fixed SHX renderer\/label/);
    const forbidden = { ...mockPair('gpu'), label: 'loaded-warm', referencePng: 'invalid', actualPng: 'invalid' };
    expect(() => compareShippingShxPair(forbidden)).toThrow(/Fixed SHX renderer\/label/);
  });

  it('accepts exact complete Canvas pixels and rejects a one-byte alpha change', () => {
    const pair = mockPair();
    expect(compareShippingShxPair(pair)).toMatchObject({ rawPixels: 0, rasterFraction: 0, canvasMissed: 0, gpuMissed: 0 });
    pair.actualPng = mockPng(image => { image.data[(14 * 64 + 14) * 4 + 3] = 254; });
    expect(() => compareShippingShxPair(pair)).toThrow();
  });

  it.each(['draws', 'uploads', 'clear', 'uploadBytes'] as const)('rejects partial Canvas GPU %s evidence', counter => {
    const pair = mockPair(); pair.glCalls[counter] = 1;
    expect(() => compareShippingShxPair(pair)).toThrow(/zero GPU submission/);
  });

  it.each(['draws', 'clear'] as const)('requires positive mock GPU %s evidence even with identical pixels', counter => {
    const pair = mockPair('gpu'); pair.glCalls[counter] = 0;
    expect(() => compareShippingShxPair(pair)).toThrow(/actual GPU/);
  });

  it('rejects absent ink and a changed drawing independently of pixel parity', () => {
    const blank = mockPng(image => {
      for (let at = 0; at < image.data.length; at += 4) image.data.set([33, 40, 48, 255], at);
    });
    expect(() => compareShippingShxPair({ ...mockPair(), referencePng: blank, actualPng: blank })).toThrow(/meaningful actual/);
    expect(() => compareShippingShxPair({ ...mockPair(), documentUnchanged: false })).toThrow();
  });

  it('requires sixteen independently changed prior-image pixels while retaining exact Canvas actual/reference', () => {
    const pair: ShxPair = {
      ...mockPair(), label: 'initial-load-txt',
      beforeResourcePng: mockPng(image => {
        for (let y = 12; y < 16; y++) for (let x = 12; x < 16; x++) image.data.set([255, 0, 0, 255], (y * 64 + x) * 4);
      }),
    };
    expect(compareShippingShxPair(pair)).toMatchObject({ rawPixels: 0, fontChangedPixels: 16 });
    pair.actualPng = mockPng(image => { image.data[(14 * 64 + 14) * 4 + 3] = 254; });
    expect(() => compareShippingShxPair(pair)).toThrow();
  });

  it('rejects an initial-load image identical to its independently supplied prior image', () => {
    const pair: ShxPair = { ...mockPair(), label: 'initial-load-txt', beforeResourcePng: mockPng() };
    expect(() => compareShippingShxPair(pair)).toThrow(/visibly replace prior\/substitute ink/);
  });

  it('rejects fifteen prior-image pixel changes despite exact Canvas actual/reference', () => {
    const pair: ShxPair = {
      ...mockPair(), label: 'initial-load-txt',
      beforeResourcePng: mockPng(image => {
        for (let pixel = 0; pixel < 15; pixel++) {
          const x = 12 + pixel % 8, y = 12 + Math.floor(pixel / 8);
          image.data.set([255, 0, 0, 255], (y * 64 + x) * 4);
        }
      }),
    };
    expect(() => compareShippingShxPair(pair)).toThrow(/visibly replace prior\/substitute ink/);
  });

  it('rejects an actual unbound-warm GPU upload even when mock pixels match exactly', () => {
    const pair: ShxPair = { ...mockPair('gpu'), label: 'unbound-warm' };
    expect(() => compareShippingShxPair(pair)).toThrow(/actual warm GPU reuse/);
    pair.glCalls.uploads = 0; pair.glCalls.uploadBytes = 0;
    expect(compareShippingShxPair(pair)).toMatchObject({ rawPixels: 0, renderer: 'gpu' });
  });

});
