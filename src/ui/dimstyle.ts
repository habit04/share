/**
 * Dimension Style Manager (DIMSTYLE / DDIM): the named styles of the drawing with
 * Set Current / New / Modify / Delete / Compare, and the New / Modify style editor with
 * AutoCAD's tabs (Lines, Symbols and Arrows, Text, Fit, Primary Units, Alternate Units,
 * Tolerances) next to a live preview drawn with the real dimension geometry.
 *
 * Named styles are kept in the drawing's `meta.dimStyles` (see core/dimension.ts);
 * the current style is `header.dimStyle`.
 */
import type { Editor } from '../app/editor';
import type { Entity, ColorSpec, Layer } from '../core/entities';
import type { Point } from '../core/geometry';
import * as g from '../core/geometry';
import {
  DIM_ARROWS,
  arrowParts,
  diffDimStyles,
  dimensionGeometry,
  dimStyleUsage,
  findDimStyle,
  namedDimStyles,
  resolveDimStyle,
  withDimStyle,
  withoutDimStyle,
  type DimArrow,
  type DimensionEntity,
  type DimStyle,
  type DimTolerance,
} from '../core/dimension';
import { textWidth } from '../core/entities';
import { drawEntity } from '../render/draw';
import { ACI_NAMES } from '../render/palette';
import type { LinearUnits } from '../core/units';
import { modal, button, tabbedDialog, dlgGroup, dlgRow, dlgCheck, selectInput, textField } from './dialogkit';
import { esc } from './dom';

// ------------------------------------------------------------------ sample geometry (pure)

/**
 * The preview picture: a part outline with a horizontal, vertical, aligned, radius and
 * angular dimension, sized to the style so metric and imperial styles look alike.
 */
export function dimStyleSample(style: DimStyle): Entity[] {
  const r = resolveDimStyle(style);
  const u = (r.textHeight * (r.scale || 1)) / 0.18;
  const P = (x: number, y: number): Point => ({ x: x * u, y: y * u });
  const common = { layer: '0', color: 'ByLayer' as const };
  const geom: Entity[] = [
    { ...common, id: 's:outline', type: 'polyline', closed: true, points: [P(0, 0), P(3, 0), P(3, 1.2), P(1.8, 2.2), P(0, 2.2)], color: 8 },
    { ...common, id: 's:hole', type: 'circle', center: P(1.1, 1.1), radius: 0.45 * u, color: 8 },
  ];
  const dim = (id: string, d: Omit<DimensionEntity, 'id' | 'layer' | 'color' | 'type' | 'style'>): DimensionEntity => ({ ...common, id, type: 'dimension', style, ...d });
  const dims: DimensionEntity[] = [
    dim('s:h', { kind: 'linear', p1: P(0, 0), p2: P(3, 0), linePoint: P(1.5, -0.7), rotation: 0 }),
    dim('s:v', { kind: 'linear', p1: P(3, 0), p2: P(3, 1.2), linePoint: P(3.7, 0.6), rotation: Math.PI / 2 }),
    dim('s:a', { kind: 'aligned', p1: P(3, 1.2), p2: P(1.8, 2.2), linePoint: P(2.9, 2.2), rotation: 0 }),
    dim('s:r', { kind: 'radius', p1: P(1.1, 1.1), p2: g.polar(P(1.1, 1.1), Math.PI / 4, 0.45 * u), linePoint: P(1.75, 1.75), rotation: 0 }),
    dim('s:ang', { kind: 'angular', p1: P(1.8, 2.2), p2: P(3, 0), center: P(3, 1.2), linePoint: g.polar(P(3, 1.2), Math.PI * 1.15, 0.75 * u), rotation: 0 }),
  ];
  return [...geom, ...dims];
}

/** Draw entities (dimensions exploded into their coloured parts) fitted into a canvas. */
export function drawStylePreview(canvas: HTMLCanvasElement, entities: readonly Entity[], background = '#1e1e1e'): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.width;
  const h = canvas.clientHeight || canvas.height;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, w, h);
  const parts: Entity[] = [];
  for (const e of entities) {
    if (e.type === 'dimension') parts.push(...(dimensionGeometry(e, textWidth) as Entity[]));
    else parts.push(e);
  }
  let b: g.Bounds | null = null;
  for (const p of parts) b = g.unionBounds(b, partBounds(p));
  if (!b) return;
  const pad = 14;
  const bw = Math.max(b.max.x - b.min.x, 1e-6);
  const bh = Math.max(b.max.y - b.min.y, 1e-6);
  const s = Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh);
  const cx = (b.min.x + b.max.x) / 2;
  const cy = (b.min.y + b.max.y) / 2;
  const tf = { scale: s, toScreen: (p: Point) => ({ x: w / 2 + (p.x - cx) * s, y: h / 2 - (p.y - cy) * s }) };
  const layers: Layer[] = [{ name: '0', color: 7, visible: true, locked: false, lineWeight: 0.25 }];
  for (const p of parts) drawEntity(ctx, p, tf, layers, () => undefined, { lineWidthOverride: 1 });
}

function partBounds(e: Entity): g.Bounds | null {
  switch (e.type) {
    case 'line':
      return g.boundsOfPoints([e.a, e.b]);
    case 'polyline':
      return g.boundsOfPoints(e.points);
    case 'circle':
    case 'arc':
      return { min: { x: e.center.x - e.radius, y: e.center.y - e.radius }, max: { x: e.center.x + e.radius, y: e.center.y + e.radius } };
    case 'text': {
      const w = textWidth(e.text, e.height);
      const ux = { x: Math.cos(e.rotation), y: Math.sin(e.rotation) };
      const uy = { x: -Math.sin(e.rotation), y: Math.cos(e.rotation) };
      const x0 = e.align === 'center' ? -w / 2 : e.align === 'right' ? -w : 0;
      const at = (x: number, y: number) => g.add(e.position, g.add(g.scale(ux, x), g.scale(uy, y)));
      return g.boundsOfPoints([at(x0, 0), at(x0 + w, 0), at(x0, e.height), at(x0 + w, e.height)]);
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------------ styling

let cssInstalled = false;
function installCss(): void {
  if (cssInstalled || typeof document === 'undefined') return;
  cssInstalled = true;
  const st = document.createElement('style');
  st.textContent = `
  .dsm-layout { display: grid; grid-template-columns: 190px 1fr 130px; gap: 12px; }
  .dsm-list { height: 290px; overflow: auto; border: 1px solid #555; background: #262626; }
  .dsm-item { padding: 3px 8px; cursor: default; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dsm-item.current { font-weight: 600; }
  .dsm-item.current::before { content: '\\25B8 '; color: var(--accent, #3d8bff); }
  .dsm-item.sel { background: #094771; color: #fff; }
  .dsm-item:hover:not(.sel) { background: #3a3a3a; }
  .dsm-label { font-size: 11px; color: var(--text-dim, #bbb); margin-bottom: 4px; }
  .dsm-preview { width: 100%; height: 250px; display: block; border: 1px solid #555; }
  .dsm-desc { font-size: 11px; color: var(--text-muted, #999); margin-top: 6px; min-height: 30px; white-space: pre-wrap; }
  .dsm-buttons { display: flex; flex-direction: column; gap: 6px; padding-top: 18px; }
  .dsm-buttons .btn { width: 100%; }
  .dsm-edit { display: grid; grid-template-columns: 1fr 290px; gap: 12px; }
  .dsm-edit .dlg-page { min-height: 380px; }
  .dsm-edit .dlg-tabs { flex-wrap: wrap; }
  .dsm-edit .dlg-tab { padding: 4px 8px; font-size: 12px; }
  .dsm-edit .dsm-preview { height: 300px; }
  .dsm-arrow { display: inline-flex; align-items: center; gap: 6px; }
  .dsm-cmp { width: 100%; border-collapse: collapse; font-size: 12px; }
  .dsm-cmp th, .dsm-cmp td { border-bottom: 1px solid #444; padding: 3px 6px; text-align: left; }
  .dsm-cmp th { color: var(--text-dim, #bbb); font-weight: 500; }
  .dsm-cmp-wrap { max-height: 300px; overflow: auto; border: 1px solid #555; margin-top: 8px; }
  .dsm-disabled { opacity: 0.45; pointer-events: none; }
  `;
  document.head.appendChild(st);
}

// ------------------------------------------------------------------ small controls

function num(value: number, onChange: (v: number) => void, opts: { step?: number; min?: number; max?: number; integer?: boolean } = {}): HTMLInputElement {
  const i = document.createElement('input');
  i.type = 'number';
  i.className = 'input';
  i.step = String(opts.step ?? 0.0625);
  if (opts.min !== undefined) i.min = String(opts.min);
  if (opts.max !== undefined) i.max = String(opts.max);
  i.value = String(Number(value.toFixed(6)));
  const commit = () => {
    let v = parseFloat(i.value);
    if (!Number.isFinite(v)) return;
    if (opts.integer) v = Math.round(v);
    if (opts.min !== undefined) v = Math.max(opts.min, v);
    if (opts.max !== undefined) v = Math.min(opts.max, v);
    onChange(v);
  };
  i.addEventListener('input', commit);
  i.addEventListener('change', () => {
    commit();
    const v = parseFloat(i.value);
    if (Number.isFinite(v) && opts.min !== undefined && v < opts.min) i.value = String(opts.min);
  });
  i.addEventListener('keydown', (ev) => ev.stopPropagation());
  return i;
}

function colorSelect(value: ColorSpec | undefined, onChange: (v: ColorSpec | undefined) => void): HTMLSelectElement {
  const opts: Array<[string, string]> = [['', 'ByBlock (dimension colour)']];
  for (let i = 1; i <= 9; i += 1) opts.push([String(i), ACI_NAMES[i] ?? `Color ${i}`]);
  if (typeof value === 'number' && (value < 1 || value > 9)) opts.push([String(value), `Color ${value}`]);
  return selectInput(opts, value === undefined || value === 'ByLayer' ? '' : String(value), (v) => onChange(v === '' ? undefined : parseInt(v, 10)));
}

function radios<T extends string>(name: string, options: Array<[T, string]>, value: T, onChange: (v: T) => void): HTMLElement {
  const wrap = document.createElement('div');
  for (const [v, label] of options) {
    const l = document.createElement('label');
    l.className = 'dlg-check';
    const i = document.createElement('input');
    i.type = 'radio';
    i.name = name;
    i.checked = v === value;
    i.addEventListener('change', () => {
      if (i.checked) onChange(v);
    });
    l.append(i, document.createTextNode(label));
    wrap.appendChild(l);
  }
  return wrap;
}

/** Tiny canvas showing one arrowhead type (Symbols and Arrows tab). */
function arrowSwatch(type: DimArrow): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.style.width = '36px';
  c.style.height = '16px';
  c.width = 36;
  c.height = 16;
  const size = 1;
  const props = { id: 'sw', layer: '0', color: 7 as ColorSpec };
  const ents: Entity[] = [{ ...props, id: 'sw:l', type: 'line', a: { x: -1.6, y: 0 }, b: { x: 0, y: 0 } }, ...(arrowParts(type, { x: 0, y: 0 }, { x: 1, y: 0 }, size, props) as Entity[])];
  if (typeof c.getContext === 'function') drawStylePreview(c, ents, '#262626');
  return c;
}

const LUNITS: Array<[string, string]> = [
  ['1', 'Scientific'],
  ['2', 'Decimal'],
  ['3', 'Engineering'],
  ['4', 'Architectural'],
  ['5', 'Fractional'],
];
const PRECISION: Array<[string, string]> = Array.from({ length: 9 }, (_, i) => [String(i), i === 0 ? '0' : `0.${'0'.repeat(i)}`]);

/** Split DIMPOST into prefix / suffix around "<>". */
export function splitPost(post: string): { prefix: string; suffix: string } {
  const i = post.indexOf('<>');
  return i < 0 ? { prefix: '', suffix: post } : { prefix: post.slice(0, i), suffix: post.slice(i + 2) };
}

/** Build DIMPOST from a prefix and a suffix (a bare suffix needs no "<>"). */
export function joinPost(prefix: string, suffix: string): string {
  return prefix ? `${prefix}<>${suffix}` : suffix;
}

// ------------------------------------------------------------------ style editor (New / Modify)

/**
 * The New / Modify Dimension Style dialog. Resolves with the edited style, or null when cancelled.
 */
export function editDimStyleDialog(title: string, initial: DimStyle): Promise<DimStyle | null> {
  installCss();
  return new Promise((resolve) => {
    let draft: DimStyle = { ...initial };
    const m = modal(esc(title), 900, 'dark');
    let done = false;
    const finish = (v: DimStyle | null) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    m.onClose(() => finish(null));
    const preview = document.createElement('canvas');
    preview.className = 'dsm-preview';
    const refresh: Array<() => void> = [];
    const update = (patch: Partial<DimStyle>) => {
      draft = { ...draft, ...patch };
      redraw();
    };
    const redraw = () => {
      for (const fn of refresh) fn();
      drawStylePreview(preview, dimStyleSample(draft));
    };
    const r0 = resolveDimStyle(draft);
    const enableWhen = (el: HTMLElement, pred: () => boolean) => refresh.push(() => el.classList.toggle('dsm-disabled', !pred()));

    // Lines
    const lines = document.createElement('div');
    lines.append(
      dlgGroup('Dimension lines', [
        dlgRow('Color:', colorSelect(r0.dimLineColor, (v) => update({ dimLineColor: v }))),
        dlgRow('Extend beyond ticks:', num(r0.dimLineExtend, (v) => update({ dimLineExtend: v }), { min: 0 })),
        dlgRow('Baseline spacing:', num(r0.baselineSpacing, (v) => update({ baselineSpacing: v }), { min: 0 })),
        dlgCheck('Suppress dim line 1', r0.suppressDimLine1, (v) => update({ suppressDimLine1: v })),
        dlgCheck('Suppress dim line 2', r0.suppressDimLine2, (v) => update({ suppressDimLine2: v })),
      ]),
      dlgGroup('Extension lines', [
        dlgRow('Color:', colorSelect(r0.extLineColor, (v) => update({ extLineColor: v }))),
        dlgCheck('Suppress ext line 1', r0.suppressExt1, (v) => update({ suppressExt1: v })),
        dlgCheck('Suppress ext line 2', r0.suppressExt2, (v) => update({ suppressExt2: v })),
        dlgRow('Extend beyond dim lines:', num(r0.extExtend, (v) => update({ extExtend: v }), { min: 0 })),
        dlgRow('Offset from origin:', num(r0.extOffset, (v) => update({ extOffset: v }), { min: 0 })),
      ]),
    );

    // Symbols and Arrows
    const arrowOpts = DIM_ARROWS.map((a) => [a.id, a.label] as [string, string]);
    const arrowRow = (label: string, value: DimArrow, set: (v: DimArrow) => void) => {
      const wrap = document.createElement('div');
      wrap.className = 'dsm-arrow';
      let sw = arrowSwatch(value);
      const sel = selectInput(arrowOpts, value, (v) => {
        const nsw = arrowSwatch(v as DimArrow);
        sw.replaceWith(nsw);
        sw = nsw;
        set(v as DimArrow);
      });
      wrap.append(sw, sel);
      return dlgRow(label, wrap);
    };
    const symbols = document.createElement('div');
    symbols.append(
      dlgGroup('Arrowheads', [
        arrowRow('First:', r0.arrow, (v) => update({ arrow: v, ...(draft.arrow2 === undefined || draft.arrow2 === draft.arrow ? { arrow2: undefined } : {}) })),
        arrowRow('Second:', r0.arrow2, (v) => update({ arrow2: v })),
        dlgRow('Arrow size:', num(r0.arrowSize, (v) => update({ arrowSize: v }), { min: 0 })),
      ]),
      dlgGroup('Center marks', [dlgRow('Size (0 = none):', num(r0.centerMark, (v) => update({ centerMark: v }), { min: 0 }))]),
    );

    // Text
    const text = document.createElement('div');
    text.append(
      dlgGroup('Text appearance', [
        dlgRow('Text color:', colorSelect(r0.textColor, (v) => update({ textColor: v }))),
        dlgRow('Text height:', num(r0.textHeight, (v) => update({ textHeight: v }), { min: 0.0001 })),
      ]),
      dlgGroup('Text placement', [
        dlgRow(
          'Vertical:',
          selectInput(
            [
              ['centered', 'Centered'],
              ['above', 'Above'],
              ['outside', 'Outside'],
              ['below', 'Below'],
            ],
            r0.textVertical,
            (v) => update({ textVertical: v as DimStyle['textVertical'] }),
          ),
        ),
        dlgRow(
          'Horizontal:',
          selectInput(
            [
              ['centered', 'Centered'],
              ['ext1', 'At Ext Line 1'],
              ['ext2', 'At Ext Line 2'],
            ],
            r0.textJustify,
            (v) => update({ textJustify: v as DimStyle['textJustify'] }),
          ),
        ),
        dlgRow('Offset from dim line:', num(r0.textGap, (v) => update({ textGap: v }), { min: 0 })),
      ]),
      dlgGroup('Text alignment', [
        radios(
          'dsm-talign',
          [
            ['horizontal', 'Horizontal'],
            ['aligned', 'Aligned with dimension line'],
            ['iso', 'ISO standard'],
          ],
          r0.textAlign,
          (v) => update({ textAlign: v }),
        ),
      ]),
    );

    // Fit
    const fit = document.createElement('div');
    fit.append(
      dlgGroup('Fit options: if there is not enough room between the extension lines, move outside first', [
        radios(
          'dsm-fit',
          [
            ['best', 'Either text or arrows (best fit)'],
            ['arrows', 'Arrows'],
            ['text', 'Text'],
            ['both', 'Both text and arrows'],
          ],
          r0.fit,
          (v) => update({ fit: v }),
        ),
        dlgCheck('Always keep text between ext lines', r0.textInside, (v) => update({ textInside: v })),
      ]),
      dlgGroup('Scale for dimension features', [dlgRow('Use overall scale of:', num(r0.scale, (v) => update({ scale: v }), { min: 0.0001, step: 0.25 }))]),
      dlgGroup('Fine tuning', [dlgCheck('Draw dim line between ext lines', r0.dimLineInside, (v) => update({ dimLineInside: v }))]),
    );

    // Primary units
    const post0 = splitPost(r0.post);
    let prefix = post0.prefix;
    let suffix = post0.suffix;
    const primary = document.createElement('div');
    primary.append(
      dlgGroup('Linear dimensions', [
        dlgRow('Unit format:', selectInput(LUNITS, String(r0.lunit), (v) => update({ lunit: parseInt(v, 10) as LinearUnits }))),
        dlgRow('Precision:', selectInput(PRECISION, String(r0.decimals), (v) => update({ decimals: parseInt(v, 10) }))),
        dlgRow('Round off:', num(r0.round, (v) => update({ round: v }), { min: 0 })),
        dlgRow(
          'Prefix:',
          textField(prefix, (v) => {
            prefix = v;
            update({ post: joinPost(prefix, suffix) });
          }),
        ),
        dlgRow(
          'Suffix:',
          textField(suffix, (v) => {
            suffix = v;
            update({ post: joinPost(prefix, suffix) });
          }),
        ),
        dlgRow('Measurement scale factor:', num(r0.linearFactor, (v) => update({ linearFactor: v }), { min: 0.000001, step: 0.1 })),
        dlgCheck('Suppress leading zeros', r0.suppressLeadingZeros, (v) => update({ suppressLeadingZeros: v })),
        dlgCheck('Suppress trailing zeros', r0.suppressTrailingZeros, (v) => update({ suppressTrailingZeros: v })),
      ]),
      dlgGroup('Angular dimensions', [dlgRow('Precision:', selectInput(PRECISION, String(r0.angularDecimals), (v) => update({ angularDecimals: parseInt(v, 10) })))]),
    );

    // Alternate units
    const altBody = document.createElement('div');
    const altPost0 = splitPost(r0.altPost);
    let altPrefix = altPost0.prefix;
    let altSuffix = altPost0.suffix;
    altBody.append(
      dlgGroup('Alternate units', [
        dlgRow('Unit format:', selectInput(LUNITS, String(r0.altLunit), (v) => update({ altLunit: parseInt(v, 10) as LinearUnits }))),
        dlgRow('Precision:', selectInput(PRECISION, String(r0.altDecimals), (v) => update({ altDecimals: parseInt(v, 10) }))),
        dlgRow('Multiplier for alt units:', num(r0.altFactor, (v) => update({ altFactor: v }), { min: 0.000001, step: 0.1 })),
        dlgRow(
          'Prefix:',
          textField(altPrefix, (v) => {
            altPrefix = v;
            update({ altPost: altPrefix || altSuffix ? `${altPrefix}<>${altSuffix}` : '' });
          }),
        ),
        dlgRow(
          'Suffix:',
          textField(altSuffix, (v) => {
            altSuffix = v;
            update({ altPost: altPrefix || altSuffix ? `${altPrefix}<>${altSuffix}` : '' });
          }),
        ),
      ]),
      dlgGroup('Placement', [
        radios(
          'dsm-altpos',
          [
            ['after', 'After primary value'],
            ['below', 'Below primary value'],
          ],
          r0.altPlacement,
          (v) => update({ altPlacement: v }),
        ),
      ]),
    );
    enableWhen(altBody, () => resolveDimStyle(draft).altUnits);
    const alternate = document.createElement('div');
    alternate.append(dlgCheck('Display alternate units', r0.altUnits, (v) => update({ altUnits: v })), altBody);

    // Tolerances
    const tolUpper = dlgRow('Upper value:', num(r0.tolPlus, (v) => update({ tolPlus: v }), { step: 0.001 }));
    const tolLower = dlgRow('Lower value:', num(r0.tolMinus, (v) => update({ tolMinus: v }), { step: 0.001 }));
    const tolPrec = dlgRow('Precision:', selectInput(PRECISION, String(r0.tolDecimals), (v) => update({ tolDecimals: parseInt(v, 10) })));
    const tolScale = dlgRow('Scaling for height:', num(r0.tolScale, (v) => update({ tolScale: v }), { min: 0.1, max: 2, step: 0.05 }));
    const tolerances = document.createElement('div');
    tolerances.append(
      dlgGroup('Tolerance format', [
        dlgRow(
          'Method:',
          selectInput(
            [
              ['none', 'None'],
              ['symmetrical', 'Symmetrical'],
              ['deviation', 'Deviation'],
              ['limits', 'Limits'],
              ['basic', 'Basic'],
            ],
            r0.tolerance,
            (v) => update({ tolerance: v as DimTolerance }),
          ),
        ),
        tolPrec,
        tolUpper,
        tolLower,
        tolScale,
      ]),
    );
    const tolMode = () => resolveDimStyle(draft).tolerance;
    enableWhen(tolPrec, () => tolMode() !== 'none' && tolMode() !== 'basic');
    enableWhen(tolUpper, () => tolMode() !== 'none' && tolMode() !== 'basic');
    enableWhen(tolLower, () => tolMode() === 'deviation' || tolMode() === 'limits');
    enableWhen(tolScale, () => tolMode() === 'deviation' || tolMode() === 'limits');

    const tabs = tabbedDialog([
      ['Lines', lines],
      ['Symbols and Arrows', symbols],
      ['Text', text],
      ['Fit', fit],
      ['Primary Units', primary],
      ['Alternate Units', alternate],
      ['Tolerances', tolerances],
    ]);
    const layout = document.createElement('div');
    layout.className = 'dsm-edit';
    const right = document.createElement('div');
    const pl = document.createElement('div');
    pl.className = 'dsm-label';
    pl.textContent = 'Preview';
    right.append(pl, preview);
    layout.append(tabs, right);
    m.body.appendChild(layout);
    const ok = button('OK', true);
    const cancel = button('Cancel');
    ok.addEventListener('click', () => finish(draft));
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(ok, cancel);
    requestAnimationFrame(redraw);
  });
}

// ------------------------------------------------------------------ small prompts

function newStyleDialog(styles: readonly DimStyle[], startWith: DimStyle): Promise<{ name: string; base: DimStyle } | null> {
  installCss();
  return new Promise((resolve) => {
    const m = modal('Create New Dimension Style', 420, 'dark');
    let done = false;
    const finish = (v: { name: string; base: DimStyle } | null) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    m.onClose(() => finish(null));
    let n = 1;
    while (styles.some((s) => s.name.toUpperCase() === `COPY OF ${startWith.name}`.toUpperCase() + (n > 1 ? ` (${n})` : ''))) n += 1;
    let name = `Copy of ${startWith.name}${n > 1 ? ` (${n})` : ''}`;
    let base = startWith;
    const nameField = textField(name, (v) => (name = v));
    nameField.addEventListener('input', () => (name = nameField.value));
    const err = document.createElement('div');
    err.className = 'dlg-note';
    m.body.append(
      dlgRow('New Style Name:', nameField),
      dlgRow(
        'Start With:',
        selectInput(
          styles.map((s) => [s.name, s.name] as [string, string]),
          startWith.name,
          (v) => (base = styles.find((s) => s.name === v) ?? startWith),
        ),
      ),
      err,
    );
    const cont = button('Continue', true);
    const cancel = button('Cancel');
    cont.addEventListener('click', () => {
      const t = name.trim();
      if (!t || /[<>/\\":;?*|,=`]/.test(t)) {
        err.textContent = 'Enter a valid style name (no < > / \\ " : ; ? * | , = `).';
        return;
      }
      if (styles.some((s) => s.name.toUpperCase() === t.toUpperCase())) {
        err.textContent = `A dimension style named "${t}" already exists.`;
        return;
      }
      finish({ name: t, base });
    });
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(cont, cancel);
    setTimeout(() => nameField.select(), 0);
  });
}

function messageDialog(title: string, message: string, buttons: string[] = ['OK']): Promise<string | null> {
  return new Promise((resolve) => {
    const m = modal(esc(title), 420, 'dark');
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    m.onClose(() => finish(null));
    const p = document.createElement('div');
    p.style.whiteSpace = 'pre-wrap';
    p.style.fontSize = '12px';
    p.textContent = message;
    m.body.appendChild(p);
    buttons.forEach((b, i) => {
      const el = button(b, i === 0);
      el.addEventListener('click', () => finish(b));
      m.footer.appendChild(el);
    });
  });
}

function fmt(v: number | string): string {
  return typeof v === 'number' ? String(Number(v.toFixed(6))) : v === '' ? '""' : v;
}

function compareDialog(styles: readonly DimStyle[], a: DimStyle): Promise<void> {
  installCss();
  return new Promise((resolve) => {
    const m = modal('Compare Dimension Styles', 560, 'dark');
    m.onClose(() => resolve());
    let left = a;
    let right = styles.find((s) => s.name !== a.name) ?? a;
    const table = document.createElement('div');
    table.className = 'dsm-cmp-wrap';
    const summary = document.createElement('div');
    summary.className = 'dlg-note';
    const render = () => {
      const diff = diffDimStyles(left, right);
      summary.textContent = left === right || diff.length === 0 ? `${left.name} and ${right.name} have the same settings.` : `${diff.length} difference(s) between ${left.name} and ${right.name}.`;
      table.innerHTML = `<table class="dsm-cmp"><thead><tr><th>Description</th><th>Variable</th><th>${esc(left.name)}</th><th>${esc(right.name)}</th></tr></thead><tbody>${diff
        .map((d) => `<tr><td>${esc(d.description)}</td><td>${d.name}</td><td>${esc(fmt(d.a))}</td><td>${esc(fmt(d.b))}</td></tr>`)
        .join('')}</tbody></table>`;
    };
    const opts = styles.map((s) => [s.name, s.name] as [string, string]);
    m.body.append(
      dlgRow(
        'Compare:',
        selectInput(opts, left.name, (v) => {
          left = styles.find((s) => s.name === v) ?? left;
          render();
        }),
      ),
      dlgRow(
        'With:',
        selectInput(opts, right.name, (v) => {
          right = styles.find((s) => s.name === v) ?? right;
          render();
        }),
      ),
      summary,
      table,
    );
    const close = button('Close', true);
    close.addEventListener('click', () => {
      m.close();
      resolve();
    });
    m.footer.appendChild(close);
    render();
  });
}

// ------------------------------------------------------------------ the manager

/** Differences of a style from the current one, as the manager's description line. */
function describe(style: DimStyle, current: DimStyle): string {
  if (style.name.toUpperCase() === current.name.toUpperCase()) return `${style.name} (current style)`;
  const diff = diffDimStyles(current, style);
  if (diff.length === 0) return `${current.name} = ${style.name}`;
  return `${current.name} + ${diff
    .slice(0, 6)
    .map((d) => `${d.name} = ${fmt(d.b)}`)
    .join(', ')}${diff.length > 6 ? ', ...' : ''}`;
}

/** Open the Dimension Style Manager for the active drawing. */
export function dimStyleManager(editor: Editor, selectName?: string): void {
  installCss();
  const doc = editor.doc;
  const m = modal('Dimension Style Manager', 760, 'dark');
  const current = () => doc.header.dimStyle;
  let selected = selectName ?? current().name;
  let filter: 'all' | 'used' = 'all';
  const styles = () => {
    const all = namedDimStyles(doc.snapshot);
    // The live current style (with overrides) replaces its saved entry in the list.
    const out = all.map((s) => (s.name.toUpperCase() === current().name.toUpperCase() ? current() : s));
    return filter === 'used' ? out.filter((s) => dimStyleUsage(doc.snapshot, s.name) > 0 || s.name.toUpperCase() === current().name.toUpperCase()) : out;
  };
  const styleOf = (name: string) => styles().find((s) => s.name.toUpperCase() === name.toUpperCase()) ?? findDimStyle(doc.snapshot, name) ?? current();

  const curLabel = document.createElement('div');
  curLabel.className = 'dsm-label';
  const list = document.createElement('div');
  list.className = 'dsm-list';
  list.setAttribute('role', 'listbox');
  list.tabIndex = 0;
  const previewLabel = document.createElement('div');
  previewLabel.className = 'dsm-label';
  const preview = document.createElement('canvas');
  preview.className = 'dsm-preview';
  const desc = document.createElement('div');
  desc.className = 'dsm-desc';

  const bSet = button('Set Current');
  const bNew = button('New...');
  const bModify = button('Modify...');
  const bCompare = button('Compare...');
  const bDelete = button('Delete');
  const buttons = document.createElement('div');
  buttons.className = 'dsm-buttons';
  buttons.append(bSet, bNew, bModify, bCompare, bDelete);

  const render = () => {
    const cur = current();
    curLabel.textContent = `Current dimension style: ${cur.name}`;
    list.innerHTML = '';
    for (const s of styles()) {
      const item = document.createElement('div');
      item.className = 'dsm-item';
      item.setAttribute('role', 'option');
      if (s.name.toUpperCase() === cur.name.toUpperCase()) item.classList.add('current');
      if (s.name.toUpperCase() === selected.toUpperCase()) {
        item.classList.add('sel');
        item.setAttribute('aria-selected', 'true');
      }
      item.textContent = s.name;
      item.title = `${dimStyleUsage(doc.snapshot, s.name)} dimension(s)`;
      item.addEventListener('click', () => {
        selected = s.name;
        render();
      });
      item.addEventListener('dblclick', () => {
        selected = s.name;
        setCurrent();
      });
      list.appendChild(item);
    }
    const sel = styleOf(selected);
    previewLabel.textContent = `Preview of: ${sel.name}`;
    desc.textContent = `Description\n${describe(sel, cur)}`;
    const isCurrent = sel.name.toUpperCase() === cur.name.toUpperCase();
    bSet.disabled = isCurrent;
    bDelete.disabled = isCurrent || sel.name.toUpperCase() === 'STANDARD';
    drawStylePreview(preview, dimStyleSample(sel));
  };
  const setCurrent = () => {
    const s = styleOf(selected);
    doc.setHeader({ dimStyle: s });
    editor.log(`Current dimension style: ${s.name}`);
    render();
  };
  list.addEventListener('keydown', (ev) => {
    const names = styles().map((s) => s.name);
    const i = names.findIndex((n) => n.toUpperCase() === selected.toUpperCase());
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      ev.stopPropagation();
      selected = names[Math.max(0, Math.min(names.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)))] ?? selected;
      render();
    }
  });
  bSet.addEventListener('click', setCurrent);

  /** Save an edited style: the named set, dimensions drawn with it and (when current) the header. */
  const save = (style: DimStyle, previousName?: string) => {
    const wasCurrent = (previousName ?? style.name).toUpperCase() === current().name.toUpperCase();
    doc.transact((s) => withDimStyle(s, style));
    if (wasCurrent) doc.setHeader({ dimStyle: style });
    editor.render();
  };
  // Child dialogs replace the manager while they are open (one modal at a time keeps Escape unambiguous).
  const reopen = (name: string) => {
    m.close();
    return () => dimStyleManager(editor, name);
  };
  bNew.addEventListener('click', () => {
    const back = reopen(selected);
    void (async () => {
      const all = namedDimStyles(doc.snapshot).map((s) => (s.name.toUpperCase() === current().name.toUpperCase() ? current() : s));
      const r = await newStyleDialog(all, styleOf(selected));
      if (!r) return back();
      const edited = await editDimStyleDialog(`New Dimension Style: ${r.name}`, { ...r.base, name: r.name });
      if (edited) {
        save({ ...edited, name: r.name });
        editor.log(`Dimension style "${r.name}" created.`);
        dimStyleManager(editor, r.name);
      } else back();
    })();
  });
  bModify.addEventListener('click', () => {
    const name = styleOf(selected).name;
    const back = reopen(name);
    void (async () => {
      const edited = await editDimStyleDialog(`Modify Dimension Style: ${name}`, styleOf(name));
      if (edited) {
        save({ ...edited, name }, name);
        editor.log(`Dimension style "${name}" modified.`);
      }
      back();
    })();
  });
  bCompare.addEventListener('click', () => {
    const back = reopen(selected);
    void compareDialog(styles(), styleOf(selected)).then(back);
  });
  bDelete.addEventListener('click', () => {
    const s = styleOf(selected);
    const used = dimStyleUsage(doc.snapshot, s.name);
    const back = reopen(s.name);
    void (async () => {
      if (used > 0) {
        await messageDialog('Dimension Style - Delete', `Style "${s.name}" is used by ${used} dimension(s) and cannot be deleted.`);
        return back();
      }
      const r = await messageDialog('Dimension Style - Delete', `Delete dimension style "${s.name}"?`, ['Yes', 'No']);
      if (r === 'Yes') {
        doc.transact((st) => withoutDimStyle(st, s.name));
        editor.log(`Dimension style "${s.name}" deleted.`);
        dimStyleManager(editor, current().name);
      } else back();
    })();
  });

  const left = document.createElement('div');
  const stylesLabel = document.createElement('div');
  stylesLabel.className = 'dsm-label';
  stylesLabel.textContent = 'Styles:';
  const listFilter = selectInput(
    [
      ['all', 'All styles'],
      ['used', 'Styles in use'],
    ],
    filter,
    (v) => {
      filter = v === 'used' ? 'used' : 'all';
      render();
    },
  );
  listFilter.style.marginTop = '6px';
  listFilter.style.width = '100%';
  left.append(stylesLabel, list, listFilter);
  const middle = document.createElement('div');
  middle.append(previewLabel, preview, desc);
  const layout = document.createElement('div');
  layout.className = 'dsm-layout';
  layout.append(left, middle, buttons);
  m.body.append(curLabel, layout);
  const close = button('Close', true);
  close.addEventListener('click', () => m.close());
  m.footer.appendChild(close);
  requestAnimationFrame(render);
  render();
}

