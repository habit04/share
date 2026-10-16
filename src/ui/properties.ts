import type { Editor } from '../app/editor';
import type { ColorSpec, Entity, InsertEntity } from '../core/entities';
import type { DynamicParameterEditValue } from '../core/parametric/apply';
import { dynamicParameterRows, setDynamicParameterValue, type DynamicParameterRow } from '../tools/parametric-properties';
import { splinePoints, imageLabel, textWidth, translateEntity, rotateEntity } from '../core/entities';
import { textAnchor, textJustification } from '../core/text-placement';
import * as g from '../core/geometry';
import { PATTERN_NAMES } from '../core/hatch';
import { aciToCss, ACI_NAMES } from '../render/palette';
import { icon } from './icons';
import { GeometryBudgetError } from '../core/geometry-budget-error';
import { ConstraintPolicyError } from '../core/constraints/policy';
import { isViewportFrame, viewTwist } from '../core/layouts';
import type { Dimension3D, Solid3D } from '../model3d/types';
import { dimensionById, replaceDimension3D, replaceSolid, solidById } from '../model3d/model';
import { type LayerColorPatch, dimension3dRows, mixedSelectionLabel, patchMixedSelection, selectedDimensions3D, selectedSolids, setDimension3DText, solidRows } from '../tools3d/properties';
import { parameterRows, parameterText, setSolidParameter } from '../tools3d/properties-edit';

/** Properties palette: shows and edits the current selection (docked right). */
export class PropertiesPalette {
  readonly el: HTMLElement;
  private bodyEl: HTMLElement;

  constructor(private editor: Editor, container: HTMLElement) {
    this.el = container;
    this.el.className = 'palette properties hidden';
    const strip = document.createElement('div');
    strip.className = 'palette-strip';
    strip.innerHTML = `<span class="palette-strip-btns">${icon('close')}${icon('pin')}</span><span class="palette-strip-title">Properties</span>`;
    strip.querySelector('svg')?.addEventListener('click', () => this.el.classList.add('hidden'));
    const body = document.createElement('div');
    body.className = 'palette-body';
    const bar = document.createElement('div');
    bar.className = 'palette-titlebar';
    bar.innerHTML = `<span class="palette-title">Properties</span>`;
    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'props-body';
    body.append(bar, this.bodyEl);
    this.el.append(body, strip);
    editor.on('selection', () => this.render());
    editor.on('change', () => this.render());
    this.render();
  }

  toggle(): void {
    this.el.classList.toggle('hidden');
    this.render();
  }

  /**
   * Run one palette edit that commits through a document transaction.
   * A deliberate refusal — the geometry budget (GeometryBudgetError) or
   * the constraint policy (ConstraintPolicyError, review round 2 C08) —
   * leaves the document unchanged by construction; the palette reports
   * the refusal on the command log and re-renders, so the field shows
   * the unchanged value instead of the error escaping the change handler
   * (which left the stale typed value on screen with no explanation).
   * Any other error still throws.
   */
  private runEdit(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      if (!(error instanceof GeometryBudgetError) && !(error instanceof ConstraintPolicyError)) throw error;
      this.editor.log(error.message);
      this.render();
    }
  }

  private row(label: string, value: string | HTMLElement): HTMLElement {
    const r = document.createElement('div');
    r.className = 'prop-row';
    const l = document.createElement('span');
    l.className = 'prop-label';
    l.textContent = label;
    r.appendChild(l);
    if (typeof value === 'string') {
      const v = document.createElement('span');
      v.className = 'prop-value';
      v.textContent = value;
      r.appendChild(v);
    } else r.appendChild(value);
    return r;
  }

  private section(title: string): HTMLElement {
    const h = document.createElement('div');
    h.className = 'prop-section';
    h.textContent = title;
    return h;
  }

  private input(value: string, onCommit: (v: string) => void): HTMLInputElement {
    const i = document.createElement('input');
    i.className = 'prop-input';
    i.value = value;
    i.spellcheck = false;
    let committed = value;
    const commit = () => {
      if (i.value !== committed) {
        // Rendering can blur this input and deliver change again during the first commit.
        committed = i.value;
        onCommit(committed);
      }
    };
    i.addEventListener('change', commit);
    i.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        commit();
        i.blur();
      }
      ev.stopPropagation();
    });
    return i;
  }

  private select(options: Array<[string, string]>, value: string, onCommit: (v: string) => void): HTMLSelectElement {
    const sel = document.createElement('select');
    sel.className = 'prop-input';
    for (const [v, label] of options) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      if (v === value) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => onCommit(sel.value));
    return sel;
  }

  private render(): void {
    if (this.el.classList.contains('hidden')) return;
    const b = this.bodyEl;
    b.innerHTML = '';
    const sel = this.editor.entitiesSelected();
    const doc = this.editor.doc;
    const layers = doc.layers.map((l): [string, string] => [l.name, l.name]);
    const colors: Array<[string, string]> = [['ByLayer', 'ByLayer'], ...Object.entries(ACI_NAMES).map(([k, v]): [string, string] => [k, v])];

    // Experimental 3D: the selected solids and 3D dimensions (model space).
    const solids = doc.snapshot.model3d ? selectedSolids(doc.snapshot.model3d.solids, this.editor.selection) : [];
    const dims3d = selectedDimensions3D(doc.snapshot.model3d?.dimensions, this.editor.selection);
    // Solids (with or without 3D dimensions, no 2D objects): the solid rows.
    if (sel.length === 0 && solids.length > 0) {
      this.renderSolids(solids, layers, colors, dims3d);
      return;
    }
    // 3D dimensions only: their rows.
    if (sel.length === 0 && dims3d.length > 0) {
      this.renderDimensions3D(dims3d, layers, colors);
      return;
    }
    // 2D objects with solids / 3D dimensions: the 2D rows, Layer and Color edit all of them.
    const mixed = sel.length > 0 && solids.length + dims3d.length > 0;

    const header = document.createElement('div');
    header.className = 'prop-header';
    header.textContent = mixed ? mixedSelectionLabel(sel.length, solids.length, dims3d.length) : sel.length === 0 ? 'No selection' : sel.length === 1 ? kindName(sel[0]!) : `All (${sel.length})`;
    b.appendChild(header);

    b.appendChild(this.section('General'));
    const common = <K extends 'layer' | 'color'>(key: K) => {
      const first = sel[0]?.[key];
      const all: Array<{ layer: string; color: ColorSpec }> = [...sel, ...solids, ...dims3d];
      return all.every((e) => e[key] === first) ? String(first ?? '') : '*VARIES*';
    };
    const patchAll = (patch: LayerColorPatch) => {
      this.runEdit(() => patchMixedSelection(doc, sel, solids.map((s) => s.id), dims3d.map((d) => d.id), patch));
    };
    if (sel.length === 0) {
      b.appendChild(this.row('Layer', this.select(layers, doc.currentLayer, (v) => doc.setCurrentLayer(v))));
      b.appendChild(this.row('Objects', String(doc.entities.length)));
      b.appendChild(this.row('Layers', String(doc.layers.length)));
      b.appendChild(this.row('Blocks', String(Object.keys(doc.blocks).length)));
      return;
    }
    const layerVal = common('layer');
    b.appendChild(
      this.row(
        'Layer',
        this.select(layerVal === '*VARIES*' ? [['*VARIES*', '*VARIES*'], ...layers] : layers, layerVal, (v) => {
          if (v === '*VARIES*') return;
          if (mixed) patchAll({ layer: v });
          else this.runEdit(() => doc.replaceEntities(sel.map((e) => ({ ...e, layer: v }))));
        }),
      ),
    );
    const colorVal = common('color');
    const colorSel = this.select(colorVal === '*VARIES*' ? [['*VARIES*', '*VARIES*'], ...colors] : colors, colorVal, (v) => {
      if (v === '*VARIES*') return;
      if (mixed) {
        patchAll({ color: v === 'ByLayer' ? 'ByLayer' : parseInt(v, 10) });
        return;
      }
      this.runEdit(() => doc.replaceEntities(sel.map((e) => ({ ...e, color: v === 'ByLayer' ? ('ByLayer' as const) : parseInt(v, 10), trueColor: undefined, colorName: undefined, colorLayer: undefined }))));
    });
    const swatchWrap = document.createElement('span');
    swatchWrap.className = 'prop-color';
    const sw = document.createElement('span');
    sw.className = 'swatch';
    const layerColor = doc.layer(sel[0]!.layer)?.color ?? 7;
    sw.style.background = colorVal === 'ByLayer' ? aciToCss(layerColor) : colorVal === '*VARIES*' ? '#777' : aciToCss(parseInt(colorVal, 10));
    swatchWrap.append(sw, colorSel);
    b.appendChild(this.row('Color', swatchWrap));

    if (sel.length !== 1 || mixed) return;
    const e = sel[0]!;
    const num = (v: number) => v.toFixed(4);
    const patch = (p: Partial<Entity>) => {
      this.runEdit(() => doc.replaceEntities([{ ...e, ...p } as Entity]));
    };
    const numInput = (v: number, fn: (n: number) => void) =>
      this.input(num(v), (s) => {
        const n = parseFloat(s);
        if (Number.isFinite(n)) fn(n);
      });
    const arrayInput = (v: number, fn: (n: number) => void) =>
      this.input(num(v), (s) => {
        const n = Number(s.trim());
        if (s.trim() && Number.isFinite(n)) fn(n);
      });
    b.appendChild(this.section('Geometry'));
    switch (e.type) {
      case 'line':
        b.appendChild(this.row('Start X', numInput(e.a.x, (n) => patch({ a: { x: n, y: e.a.y } }))));
        b.appendChild(this.row('Start Y', numInput(e.a.y, (n) => patch({ a: { x: e.a.x, y: n } }))));
        b.appendChild(this.row('End X', numInput(e.b.x, (n) => patch({ b: { x: n, y: e.b.y } }))));
        b.appendChild(this.row('End Y', numInput(e.b.y, (n) => patch({ b: { x: e.b.x, y: n } }))));
        b.appendChild(this.row('Delta X', num(e.b.x - e.a.x)));
        b.appendChild(this.row('Delta Y', num(e.b.y - e.a.y)));
        b.appendChild(this.row('Length', num(Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y))));
        b.appendChild(this.row('Angle', `${((Math.atan2(e.b.y - e.a.y, e.b.x - e.a.x) * 180) / Math.PI).toFixed(2)}°`));
        break;
      case 'circle':
        b.appendChild(this.row('Center X', numInput(e.center.x, (n) => patch({ center: { x: n, y: e.center.y } }))));
        b.appendChild(this.row('Center Y', numInput(e.center.y, (n) => patch({ center: { x: e.center.x, y: n } }))));
        b.appendChild(this.row('Radius', numInput(e.radius, (n) => n > 0 && patch({ radius: n }))));
        b.appendChild(this.row('Circumference', num(2 * Math.PI * e.radius)));
        break;
      case 'arc':
        b.appendChild(this.row('Center X', numInput(e.center.x, (n) => patch({ center: { x: n, y: e.center.y } }))));
        b.appendChild(this.row('Center Y', numInput(e.center.y, (n) => patch({ center: { x: e.center.x, y: n } }))));
        b.appendChild(this.row('Radius', numInput(e.radius, (n) => n > 0 && patch({ radius: n }))));
        b.appendChild(this.row('Start angle', numInput((e.startAngle * 180) / Math.PI, (n) => patch({ startAngle: (n * Math.PI) / 180 }))));
        b.appendChild(this.row('End angle', numInput((e.endAngle * 180) / Math.PI, (n) => patch({ endAngle: (n * Math.PI) / 180 }))));
        break;
      case 'polyline':
        if (isViewportFrame(e)) {
          b.appendChild(this.section('Viewport'));
          const rotationInput = numInput(g.deg(viewTwist(e.vport.view)), (n) => {
            if (e.vport.view.locked) return;
            const edited: typeof e = { ...e, vport: { ...e.vport, view: { ...e.vport.view, twist: g.rad(n) } } };
            this.runEdit(() => doc.replaceEntities([edited]));
          });
          rotationInput.disabled = Boolean(e.vport.view.locked);
          rotationInput.title = e.vport.view.locked ? 'Unlock the viewport with MVIEW before changing its view rotation.' : 'Degrees; positive turns the model counterclockwise on the sheet.';
          b.appendChild(this.row('View rotation', rotationInput));
        }
        b.appendChild(this.row('Vertices', String(e.points.length)));
        b.appendChild(this.row('Closed', this.select([['1', 'Yes'], ['0', 'No']], e.closed ? '1' : '0', (v) => patch({ closed: v === '1' }))));
        break;
      case 'text': {
        const anchor = textAnchor(e);
        const horizontal = e.justification?.horizontal ?? (e.align === 'center' ? 1 : e.align === 'right' ? 2 : 0);
        const move = (p: g.Point) => patch(translateEntity(e, g.sub(p, anchor)));
        b.appendChild(this.row('Contents', this.input(e.text, (v) => patch({ text: v }))));
        b.appendChild(this.row('Height', numInput(e.height, (n) => n > 0 && patch({ height: n }))));
        const rotation = (horizontal === 3 || horizontal === 5) && e.alignmentPoint ? g.angleOf(e.position, e.alignmentPoint) : e.rotation;
        b.appendChild(this.row('Rotation', numInput(g.deg(rotation), (n) => patch(rotateEntity(e, anchor, g.rad(n) - rotation)))));
        b.appendChild(this.row('Justify', this.select([['0', 'Left'], ['1', 'Center'], ['2', 'Right'], ['3', 'Aligned'], ['4', 'Middle'], ['5', 'Fit']], String(horizontal), (value) => {
          const h = Number(value);
          const span = Math.max(1e-6, textWidth(e.text, e.height) * (e.widthFactor ?? 1));
          patch({ position: anchor, align: h === 1 || h === 4 ? 'center' : h === 2 ? 'right' : 'left', justification: textJustification(h, h > 2 ? 0 : e.justification?.vertical ?? 0), alignmentPoint: h === 3 || h === 5 ? e.alignmentPoint ?? g.polar(anchor, e.rotation, span) : anchor });
        })));
        if (horizontal <= 2) b.appendChild(this.row('Vertical', this.select([['0', 'Baseline'], ['1', 'Bottom'], ['2', 'Middle'], ['3', 'Top']], String(e.justification?.vertical ?? 0), (v) => patch({ justification: textJustification(horizontal, Number(v)), alignmentPoint: e.alignmentPoint ?? anchor }))));
        b.appendChild(this.row('X', numInput(anchor.x, (n) => move({ x: n, y: anchor.y }))));
        b.appendChild(this.row('Y', numInput(anchor.y, (n) => move({ x: anchor.x, y: n }))));
        break;
      }
      case 'insert': {
        const block = doc.lookupBlock(e.block);
        b.appendChild(this.row('Name', e.block));
        if (block?.description) b.appendChild(this.row('Symbol', block.description));
        b.appendChild(this.row('X', numInput(e.position.x, (n) => patch({ position: { x: n, y: e.position.y } }))));
        b.appendChild(this.row('Y', numInput(e.position.y, (n) => patch({ position: { x: e.position.x, y: n } }))));
        b.appendChild(this.row('Rotation', numInput((e.rotation * 180) / Math.PI, (n) => patch({ rotation: (n * Math.PI) / 180 }))));
        b.appendChild(this.row('Scale', numInput(e.scale, (n) => n > 0 && patch({ scale: n }))));
        b.appendChild(this.section('Array'));
        b.appendChild(this.row('Columns', arrayInput(e.columns ?? 1, (n) => Number.isSafeInteger(n) && n > 0 && n <= 65535 && patch({ columns: n }))));
        b.appendChild(this.row('Rows', arrayInput(e.rows ?? 1, (n) => Number.isSafeInteger(n) && n > 0 && n <= 65535 && patch({ rows: n }))));
        b.appendChild(this.row('Column spacing', arrayInput(e.columnSpacing ?? 0, (n) => patch({ columnSpacing: n }))));
        b.appendChild(this.row('Row spacing', arrayInput(e.rowSpacing ?? 0, (n) => patch({ rowSpacing: n }))));
        if (block && (block.dynamic || block.dynamicRetained !== undefined)) {
          // Dynamic-block parameters (30.4): rows from the pure builder in
          // tools/parametric-properties.ts; commits go through
          // setDynamicParameter, never through the entity `patch` above —
          // a parameter edit is a document transition, not a field write.
          const dynRows = dynamicParameterRows(block, e);
          if (dynRows.length) {
            b.appendChild(this.section('Parameters'));
            for (const r of dynRows) b.appendChild(this.dynamicParameterRow(e, r));
          }
        }
        if (block && block.attributes.length) {
          b.appendChild(this.section('Attributes'));
          for (const a of block.attributes) {
            b.appendChild(this.row(a.tag, this.input(e.attributes[a.tag] ?? a.default, (v) => patch({ attributes: { ...e.attributes, [a.tag]: v } }))));
          }
        }
        if (block?.xref) b.appendChild(this.row('Xref path', block.xref.path || '(unknown)'));
        break;
      }
      case 'mtext':
        b.appendChild(this.row('Contents', this.input(e.text.replace(/\n/g, '\\P'), (v) => patch({ text: v.replace(/\\P/g, '\n') }))));
        b.appendChild(this.row('Height', numInput(e.height, (n) => n > 0 && patch({ height: n }))));
        b.appendChild(this.row('Width', numInput(e.width, (n) => n >= 0 && patch({ width: n }))));
        if (e.field) b.appendChild(this.row('Field', e.field.value === e.text ? e.field.code : '(text edited)'));
        break;
      case 'spline': {
        b.appendChild(this.row('Degree', String(e.degree)));
        b.appendChild(this.row('Control vertices', String(e.controlPoints.length)));
        b.appendChild(this.row('Fit points', String(e.fitPoints?.length ?? 0)));
        b.appendChild(this.row('Closed', e.closed ? 'Yes' : 'No'));
        const pts = splinePoints(e);
        let len = 0;
        for (let i = 1; i < pts.length; i += 1) len += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
        b.appendChild(this.row('Length', num(len)));
        break;
      }
      case 'hatch': {
        b.appendChild(this.section('Pattern'));
        const names = PATTERN_NAMES.includes(e.pattern) ? PATTERN_NAMES : [e.pattern, ...PATTERN_NAMES];
        b.appendChild(
          this.row(
            'Pattern name',
            this.select(
              names.map((n): [string, string] => [n, n]),
              e.solid ? 'SOLID' : e.pattern,
              (v) => {
                const { patternLines: _custom, ...rest } = e;
                this.runEdit(() => doc.replaceEntities([{ ...rest, pattern: v, solid: v === 'SOLID', patternType: 1 }]));
              },
            ),
          ),
        );
        if (!e.solid) {
          // Definition lines read from a file are regenerated from the pattern table once angle / scale change.
          const known = PATTERN_NAMES.includes(e.pattern);
          const setPattern = (p: { angle?: number; scale?: number }) => {
            const { patternLines, ...rest } = e;
            this.runEdit(() => doc.replaceEntities([known ? { ...rest, ...p } : { ...rest, patternLines, ...p }]));
          };
          b.appendChild(this.row('Angle', numInput((e.angle * 180) / Math.PI, (n) => setPattern({ angle: (n * Math.PI) / 180 }))));
          b.appendChild(this.row('Scale', numInput(e.scale, (n) => n > 0 && setPattern({ scale: n }))));
        }
        b.appendChild(this.row('Loops', String(e.loops.length)));
        b.appendChild(this.row('Associative', e.associative ? 'Yes' : 'No'));
        break;
      }
      case 'leader':
        b.appendChild(this.row('Contents', this.input((e.text ?? '').replace(/\n/g, '\\P'), (v) => patch({ text: v.replace(/\\P/g, '\n'), raw: undefined }))));
        b.appendChild(this.row('Text height', numInput(e.textHeight, (n) => n > 0 && patch({ textHeight: n }))));
        b.appendChild(this.row('Arrow size', numInput(e.arrowSize, (n) => n >= 0 && patch({ arrowSize: n }))));
        b.appendChild(this.row('Arrowhead', this.select([['1', 'Closed filled'], ['0', 'None']], e.arrow ? '1' : '0', (v) => patch({ arrow: v === '1' }))));
        b.appendChild(this.row('Vertices', String(e.vertices.length)));
        break;
      case 'table':
        b.appendChild(this.row('Rows', String(e.rowHeights.length)));
        b.appendChild(this.row('Columns', String(e.columnWidths.length)));
        b.appendChild(this.row('Width', num(e.columnWidths.reduce((a, c) => a + c, 0))));
        b.appendChild(this.row('Height', num(e.rowHeights.reduce((a, c) => a + c, 0))));
        b.appendChild(this.row('X', numInput(e.position.x, (n) => patch({ position: { x: n, y: e.position.y } }))));
        b.appendChild(this.row('Y', numInput(e.position.y, (n) => patch({ position: { x: e.position.x, y: n } }))));
        break;
      case 'image':
        b.appendChild(this.row('Name', imageLabel(e)));
        b.appendChild(this.row('Path', e.path || '(unknown)'));
        b.appendChild(this.row('Size (px)', `${e.size.x} x ${e.size.y}`));
        b.appendChild(this.row('Width', num(Math.hypot(e.u.x, e.u.y) * e.size.x)));
        b.appendChild(this.row('Height', num(Math.hypot(e.v.x, e.v.y) * e.size.y)));
        b.appendChild(this.row('Clipped', e.clipOn ? 'Yes' : 'No'));
        break;
    }
  }

  /**
   * One row of the dynamic Parameters section. Distance/angle are numeric
   * inputs (angles shown in degrees, the palette convention; the model
   * value is radians), flip a toggle, visibility a state choice, lookup a
   * row choice with a Custom entry. Every commit routes through
   * setDynamicParameterValue (apply.ts); a refusal is logged there and
   * the re-render shows the unchanged stored value.
   */
  private dynamicParameterRow(e: InsertEntity, row: DynamicParameterRow): HTMLElement {
    const commit = (value: DynamicParameterEditValue) => {
      setDynamicParameterValue(this.editor, e.id, row.id, value);
      this.render();
    };
    switch (row.kind) {
      case 'distance':
        return this.row(row.name, this.input(row.value.toFixed(4), (s) => {
          const n = parseFloat(s);
          if (Number.isFinite(n)) commit(n);
          else this.render();
        }));
      case 'angle':
        return this.row(row.name, this.input(((row.value * 180) / Math.PI).toFixed(4), (s) => {
          const n = parseFloat(s);
          if (Number.isFinite(n)) commit((n * Math.PI) / 180);
          else this.render();
        }));
      case 'flip':
        return this.row(row.name, this.select([['1', 'Flipped'], ['0', 'Not flipped']], row.value ? '1' : '0', (v) => commit(v === '1')));
      case 'visibility':
        return this.row(row.name, this.select(row.options.map((o): [string, string] => [o, o]), row.value, (v) => commit(v)));
      case 'lookup':
        return this.row(row.name, this.select([['', 'Custom'], ...row.options.map((o): [string, string] => [o, o])], row.value ?? '', (v) => commit(v === '' ? null : v)));
      case 'note':
        return this.row(row.name, row.text);
    }
  }

  /**
   * Experimental 3D solids (rows from src/tools3d/properties.ts), with any selected 3D dimensions
   * (counted in the header, included in the Layer and Color edits): layer and colour for all of
   * them, name, the editable parameters (milestone 4: sizes and segment counts of primitives and
   * sweeps, Boolean operands' parameters re-run through the kernel) and the read-only geometry for a
   * single one. Edits are one undoable step each; a refused value is reported on the command line
   * and the row shows the unchanged value again.
   */
  private renderSolids(solids: Solid3D[], layers: Array<[string, string]>, colors: Array<[string, string]>, dims: Dimension3D[] = []): void {
    const b = this.bodyEl;
    const doc = this.editor.doc;
    const header = document.createElement('div');
    header.className = 'prop-header';
    header.textContent = dims.length ? mixedSelectionLabel(0, solids.length, dims.length) : solids.length === 1 ? '3D Solid' : `3D Solids (${solids.length})`;
    b.appendChild(header);
    const patchAll = (patch: LayerColorPatch) => {
      this.runEdit(() => patchMixedSelection(doc, [], solids.map((s) => s.id), dims.map((d) => d.id), patch));
    };
    const update = (fn: (s: Solid3D) => Solid3D) => {
      this.runEdit(() => doc.updateModel3D((m) => solids.reduce((acc, s) => {
        const cur = solidById(acc, s.id);
        return cur ? replaceSolid(acc, fn(cur)) : acc;
      }, m)));
    };
    const common = (key: 'layer' | 'color') => {
      const first = String(solids[0]![key]);
      return [...solids, ...dims].every((s) => String(s[key]) === first) ? first : '*VARIES*';
    };
    const rows = solidRows(solids[0]!);
    b.appendChild(this.section('General'));
    if (solids.length === 1 && !dims.length) b.appendChild(this.row('Type', rows[0]!.value));
    const layerVal = common('layer');
    b.appendChild(this.row('Layer', this.select(layerVal === '*VARIES*' ? [['*VARIES*', '*VARIES*'], ...layers] : layers, layerVal, (v) => {
      if (v === '*VARIES*') return;
      if (dims.length) patchAll({ layer: v });
      else update((s) => ({ ...s, layer: v }));
    })));
    const colorVal = common('color');
    b.appendChild(this.row('Color', this.select(colorVal === '*VARIES*' ? [['*VARIES*', '*VARIES*'], ...colors] : colors, colorVal, (v) => {
      if (v === '*VARIES*') return;
      const color: ColorSpec = v === 'ByLayer' ? 'ByLayer' : parseInt(v, 10);
      if (dims.length) patchAll({ color });
      else update((s) => ({ ...s, color }));
    })));
    if (solids.length !== 1 || dims.length) return;
    b.appendChild(this.row('Name', this.input(solids[0]!.name ?? '', (v) => update((s) => {
      const { name: _old, ...rest } = s;
      return v.trim() ? { ...rest, name: v.trim() } : rest;
    }))));
    const params = parameterRows(solids[0]!.feature);
    if (params.length) {
      const id = solids[0]!.id;
      b.appendChild(this.section('Parameters'));
      for (const p of params) {
        b.appendChild(this.row(p.label, this.input(parameterText(p), (v) => {
          // Applied in place (a running command keeps running); a Boolean re-runs as a command.
          setSolidParameter(this.editor, id, p.key, v);
          // A refused value leaves the model unchanged (no 'change' event): show the stored value.
          this.render();
        })));
      }
    }
    b.appendChild(this.section('Geometry'));
    for (const r of rows) if (!r.edit && r.label !== 'Type') b.appendChild(this.row(r.label, r.value));
  }

  /**
   * Experimental 3D dimensions (rows from src/tools3d/properties.ts): layer and colour for all of
   * them; kind, measurement, text override (editable), shown text and plane for a single one. Each
   * edit is one undoable step.
   */
  private renderDimensions3D(dims: Dimension3D[], layers: Array<[string, string]>, colors: Array<[string, string]>): void {
    const b = this.bodyEl;
    const doc = this.editor.doc;
    const header = document.createElement('div');
    header.className = 'prop-header';
    header.textContent = dims.length === 1 ? '3D Dimension' : `3D Dimensions (${dims.length})`;
    b.appendChild(header);
    const update = (fn: (d: Dimension3D) => Dimension3D) => {
      this.runEdit(() => doc.updateModel3D((m) => dims.reduce((acc, d) => {
        const cur = dimensionById(acc, d.id);
        return cur ? replaceDimension3D(acc, fn(cur)) : acc;
      }, m)));
    };
    const common = (key: 'layer' | 'color') => {
      const first = String(dims[0]![key]);
      return dims.every((d) => String(d[key]) === first) ? first : '*VARIES*';
    };
    const rows = dimension3dRows(dims[0]!, doc.header.units);
    b.appendChild(this.section('General'));
    const layerVal = common('layer');
    b.appendChild(this.row('Layer', this.select(layerVal === '*VARIES*' ? [['*VARIES*', '*VARIES*'], ...layers] : layers, layerVal, (v) => {
      if (v !== '*VARIES*') update((d) => ({ ...d, layer: v }));
    })));
    const colorVal = common('color');
    b.appendChild(this.row('Color', this.select(colorVal === '*VARIES*' ? [['*VARIES*', '*VARIES*'], ...colors] : colors, colorVal, (v) => {
      if (v !== '*VARIES*') update((d) => ({ ...d, color: v === 'ByLayer' ? 'ByLayer' : parseInt(v, 10) }));
    })));
    if (dims.length !== 1) return;
    b.appendChild(this.section('Dimension'));
    for (const r of rows) {
      if (r.edit === 'layer' || r.edit === 'color') continue;
      if (r.edit === 'text') {
        const id = dims[0]!.id;
        b.appendChild(this.row(r.label, this.input(r.value, (v) => {
          if (!setDimension3DText(doc, id, v)) this.render();
        })));
      } else b.appendChild(this.row(r.label, r.value));
    }
  }
}

function kindName(e: Entity): string {
  switch (e.type) {
    case 'line':
      return 'Line';
    case 'circle':
      return 'Circle';
    case 'arc':
      return 'Arc';
    case 'polyline':
      return 'Polyline';
    case 'text':
      return 'Text';
    case 'insert':
      return 'Block Reference';
    case 'mtext':
      return 'MText';
    case 'hatch':
      return 'Hatch';
    case 'leader':
      return e.kind === 'mleader' ? 'Multileader' : 'Leader';
    case 'table':
      return 'Table';
    case 'image':
      return 'Raster Image';
    default:
      return e.type.charAt(0).toUpperCase() + e.type.slice(1);
  }
}
