/**
 * Pointer input: the snapped / tracked cursor point, rollover highlight, picking and selection
 * boxes, grip editing, panning with the middle button, wheel zoom and double-click editing.
 * The Editor's public methods delegate here (their documentation is on the Editor).
 */
import type { Point } from '../../core/geometry';
import * as g from '../../core/geometry';
import type { DrawingState } from '../../core/document';
import type { Entity } from '../../core/entities';
import { gripPoints, moveGrip } from '../../core/entities';
import { resolveDynamicGripDrag, type DynamicGripEditResult } from '../../core/parametric/grips';
import { findObjectSnap, constrainDirection, snapToGrid, trackFromPoints, type SnapResult } from '../../core/snap';
import { activeSelectionClip, pickEntity, selectByBox, selectByPolygon } from '../../core/selection';
import { PanTool } from '../../tools/edit';
import type { Editor } from './editor';
import { fallbackUi, type EditorInternals } from './internals';
import { makeContext, acceptPoint, updateCursorMode } from './prompter';
import { toggleSelect, hiddenLayers, lockedLayers, pickAperture, graphicalSelectionEntities } from './selection';

export function screenFromEvent(ed: Editor, ev: MouseEvent): Point {
  const r = ed.viewport.canvas.getBoundingClientRect();
  return { x: ev.clientX - r.left, y: ev.clientY - r.top };
}

/** Compute the effective (snapped/constrained) world point for the cursor. */
export function resolveCursor(ed: Editor, st: EditorInternals, screen: Point): { world: Point; snap: SnapResult | null } {
  const raw = ed.viewport.toWorld(screen);
  // Object snap target box: Options > Drafting > Aperture Size (px, full box; default 10 -> 7 px reach).
  const aperture = (ed.settings.apertureSize / 2 + 2) * ed.viewport.worldPerPixel();
  const wantSnap = (ed.tool !== null || st.gripDrag !== null) && !st.selReq;
  const clip = activeSelectionClip(ed.doc.snapshot);
  const inside = !clip || clip.contains(raw);
  const snap = wantSnap && inside
    ? findObjectSnap(raw, graphicalSelectionEntities(ed), ed.doc.lookupBlock, ed.snap, aperture, st.overlay.trackFrom, hiddenLayers(ed), clip?.contains)
    : null;
  st.overlay.trackPaths = undefined;
  if (snap) {
    // Object snap tracking acquires the points the cursor pauses on (the last two).
    if (ed.snap.otrack && wantSnap && snap.kind !== 'perpendicular' && snap.kind !== 'nearest') {
      if (!st.acquired.some((q) => g.eq(q, snap.point, 1e-9))) st.acquired = [...st.acquired.slice(-1), snap.point];
      st.overlay.acquired = st.acquired;
    }
    return { world: snap.point, snap };
  }
  let p = raw;
  if (ed.snap.otrack && wantSnap && inside) {
    const bases = (st.overlay.trackFrom ? [...st.acquired, st.overlay.trackFrom] : st.acquired).filter((p) => !clip || clip.contains(p));
    const tr = trackFromPoints(raw, bases, ed.snap, aperture);
    if (tr && (!clip || clip.contains(tr.point))) {
      st.overlay.trackPaths = tr.paths;
      return { world: tr.point, snap: { point: tr.point, kind: 'tracking' } };
    }
  }
  if (st.overlay.trackFrom) p = constrainDirection(st.overlay.trackFrom, p, ed.snap);
  p = snapToGrid(p, ed.snap);
  return { world: p, snap: null };
}

export function onMouseMove(ed: Editor, st: EditorInternals, ev: MouseEvent): unknown {
  const s = ed.screenFromEvent(ev);
  if (st.panning) {
    ed.viewport.panByPixels(s.x - st.lastMouse.x, s.y - st.lastMouse.y);
    st.lastMouse = s;
    ed.render();
    ed.notify('view');
    return;
  }
  st.lastMouse = s;
  const { world, snap } = resolveCursor(ed, st, s);
  st.cursorWorld = world;
  st.overlay.cursor = world;
  st.overlay.snap = snap;
  const clip = activeSelectionClip(ed.doc.snapshot);
  const inside = !clip || clip.contains(ed.viewport.toWorld(s));
  if (!inside) st.overlay.hover = null;
  let result: unknown;

  if (st.gripDrag) {
    const drag = st.gripDrag;
    const dyn = dynamicDrag(ed, drag.entity, drag.index, world);
    // A refused dynamic drag previews as the unmoved entity: the value
    // never partially applies, so there is nothing else honest to show.
    const moved = dyn
      ? dyn.problem
        ? drag.entity
        : (dyn.state.entities.find((x) => x.id === drag.entity.id) ?? drag.entity)
      : applyGrip(drag.entity, drag.index, world);
    st.overlay.ghost = moved ? [moved] : [];
    st.overlay.dynText = [`${g.dist(st.gripDrag.start, world).toFixed(4)}`];
    ed.render();
    ed.notify('view');
    return;
  }
  if (st.dragStart && st.dragWorld) {
    const raw = ed.viewport.toWorld(s);
    if (g.dist(st.dragStart, s) > 3) {
      st.overlay.selectionBox = { a: st.dragWorld, b: raw, mode: s.x >= st.dragStart.x ? 'window' : 'crossing' };
    }
  } else if (ed.tool) {
    if (inside) result = ed.tool.onMove(world, makeContext(ed, st));
  } else if (!inside || ed.layoutInput.hoverBlocked?.(s)) {
    st.overlay.hover = null;
  } else {
    // rollover highlight
    const hit = pickEntity(ed.viewport.toWorld(s), graphicalSelectionEntities(ed), ed.doc.lookupBlock, pickAperture(ed), hiddenLayers(ed), lockedLayers(ed));
    st.overlay.hover = hit?.id ?? null;
    st.overlay.dynText = [];
  }
  ed.render();
  ed.notify('view');
  return result;
}

export function onMouseDown(ed: Editor, st: EditorInternals, ev: MouseEvent): unknown {
  const s = ed.screenFromEvent(ev);
  st.lastMouse = s;
  if (ev.button === 1 || (ev.button === 0 && ed.tool instanceof PanTool && !st.selReq)) {
    ev.preventDefault();
    st.panning = true;
    return;
  }
  if (ev.button !== 0) return;
  if (!st.selReq && ed.layoutInput.mouseDown?.(s)) return;
  const raw = ed.viewport.toWorld(s);
  const clip = activeSelectionClip(ed.doc.snapshot);
  if (clip && !clip.contains(raw)) return;
  const { world } = resolveCursor(ed, st, s);
  if (ed.tool && !st.selReq) {
    return acceptPoint(ed, st, world);
  }
  // Selection (default tool or selection request)
  // Grip editing: press on a grip of a selected entity to stretch it.
  if (!st.selReq && ed.selection.size > 0) {
    const gripTol = 6 * ed.viewport.worldPerPixel();
    for (const e of graphicalSelectionEntities(ed)) {
      if (!ed.selection.has(e.id)) continue;
      const grips = gripPoints(e, ed.doc.lookupBlock.textGeometry, ed.doc.lookupBlock);
      const idx = grips.findIndex((gp) => (!clip || clip.contains(gp)) && g.dist(gp, raw) <= gripTol);
      if (idx >= 0) {
        st.gripDrag = { entity: e, index: idx, start: raw };
        st.overlay.trackFrom = grips[idx]!;
        ed.setPrompt('** STRETCH **  Specify stretch point:');
        st.overlay.cursorMode = 'point';
        ed.render();
        return;
      }
    }
  }
  const hit = pickEntity(raw, graphicalSelectionEntities(ed), ed.doc.lookupBlock, pickAperture(ed), hiddenLayers(ed), lockedLayers(ed));
  if (hit) {
    toggleSelect(ed, st, [hit.id], ev.shiftKey);
    return;
  }
  st.dragStart = s;
  st.dragWorld = raw;
}

export function onMouseUp(ed: Editor, st: EditorInternals, ev: MouseEvent): void {
  if (ev.button === 1 || (ev.button === 0 && st.panning)) {
    st.panning = false;
    return;
  }
  if (ev.button !== 0) return;
  if (st.gripDrag) {
    const s = ed.screenFromEvent(ev);
    const { world } = resolveCursor(ed, st, s);
    const drag = st.gripDrag;
    const original = gripPoints(drag.entity, ed.doc.lookupBlock.textGeometry, ed.doc.lookupBlock)[drag.index];
    st.gripDrag = null;
    st.overlay.ghost = [];
    st.overlay.trackFrom = null;
    st.overlay.dynText = [];
    updateCursorMode(ed, st);
    ed.setPrompt('Type a command');
    if (original && g.dist(original, world) > 1e-9) {
      const dyn = dynamicDrag(ed, drag.entity, drag.index, world);
      if (dyn) {
        // A dynamic grip commit is a parameter edit: exactly one transact
        // of the apply.ts result, or — on refusal — no change at all, with
        // the problem code on the command line (the DYNSET idiom).
        if (dyn.problem) ed.log(`Grip edit refused (${dyn.problem}): ${dyn.message ?? 'the edit was not applied.'}`);
        else ed.doc.transact(() => dyn.state);
      } else {
        const moved = applyGrip(drag.entity, drag.index, world);
        if (moved) ed.doc.replaceEntities([moved]);
      }
    }
    ed.render();
    return;
  }
  if (st.dragStart && st.dragWorld) {
    const s = ed.screenFromEvent(ev);
    if (st.overlay.selectionBox) {
      const box = st.overlay.selectionBox;
      const entities = graphicalSelectionEntities(ed);
      const found = ed.viewport.twist === 0
        ? selectByBox(g.boundsOfPoints([box.a, box.b])!, box.mode, entities, ed.doc.lookupBlock, hiddenLayers(ed), lockedLayers(ed))
        : selectByPolygon(g.viewBoxCorners(box.a, box.b, ed.viewport.twist), box.mode, entities, ed.doc.lookupBlock, hiddenLayers(ed), lockedLayers(ed));
      toggleSelect(ed, st, found.map((e) => e.id), ev.shiftKey);
    } else if (g.dist(s, st.dragStart) <= 3 && !st.selReq && !ev.shiftKey) {
      // click on empty space clears selection
      if (ed.selection.size > 0) {
        ed.selection.clear();
        ed.notify('selection');
      }
    }
    st.dragStart = null;
    st.dragWorld = null;
    st.overlay.selectionBox = null;
    ed.render();
  }
}

export function onDoubleClick(ed: Editor, ev: MouseEvent): void | Promise<void> {
  if (ev.button === 1) {
    ed.zoomExtents();
    return;
  }
  if (ev.button !== 0 || ed.tool) return;
  if (ed.layoutInput.doubleClick?.(ed.screenFromEvent(ev))) return;
  const raw = ed.viewport.toWorld(ed.screenFromEvent(ev));
  const clip = activeSelectionClip(ed.doc.snapshot);
  if (clip && !clip.contains(raw)) return;
  const hit = pickEntity(raw, graphicalSelectionEntities(ed), ed.doc.lookupBlock, pickAperture(ed), hiddenLayers(ed), lockedLayers(ed));
  if (!hit) return;
  const ui = ed.ui ?? fallbackUi;
  if (hit.type === 'text') {
    return ui.textInput('Edit Text', 'Contents', hit.text).then((v) => {
      if (v !== null && v !== hit.text) ed.doc.replaceEntities([{ ...hit, text: v }]);
    });
  } else if (hit.type === 'insert' && (hit.attributes.TAG1 !== undefined || hit.attributes.TERM01 !== undefined)) {
    if (ed.commands.has('AEEDITCOMPONENT')) {
      // The AutoCAD Electrical-style dialog edits the full data set of the picked component.
      ed.selection = new Set([hit.id]);
      ed.notify('selection');
      ed.runCommand('AEEDITCOMPONENT');
      return;
    }
    return ui
      .editComponent({ tag: hit.attributes.TAG1 ?? hit.attributes.TERM01 ?? '', desc: hit.attributes.DESC1 ?? '', block: hit.block, mfg: hit.attributes.MFG, cat: hit.attributes.CAT })
      .then((r) => {
        if (!r) return;
        const attrs = { ...hit.attributes };
        if (hit.attributes.TAG1 !== undefined) attrs.TAG1 = r.tag;
        if (hit.attributes.TERM01 !== undefined) attrs.TERM01 = r.tag;
        attrs.DESC1 = r.desc;
        if (r.mfg) attrs.MFG = r.mfg;
        else delete attrs.MFG;
        if (r.cat) attrs.CAT = r.cat;
        else delete attrs.CAT;
        ed.doc.replaceEntities([{ ...hit, attributes: attrs }]);
      });
  } else {
    ed.hooks.properties?.();
  }
}

export function onWheel(ed: Editor, st: EditorInternals, ev: WheelEvent): void {
  ev.preventDefault();
  const s = ed.screenFromEvent(ev);
  const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
  ed.viewport.zoomAt(s, factor);
  // keep cursor overlay consistent
  const { world, snap } = resolveCursor(ed, st, s);
  st.overlay.cursor = world;
  st.overlay.snap = snap;
  ed.render();
  ed.notify('view');
}

export function onMouseLeave(ed: Editor, st: EditorInternals): void {
  st.overlay.cursor = null;
  st.overlay.snap = null;
  st.overlay.hover = null;
  ed.render();
}

export function onContextMenu(ev: MouseEvent): void {
  ev.preventDefault();
}

/** Move grip `index` of an entity to `p` (AutoCAD grip stretch semantics). */
export function applyGrip(e: Entity, index: number, p: Point): Entity | null {
  return moveGrip(e, index, p);
}

/**
 * The document state as the ACTIVE SPACE sees it (review R08).
 * Drawing.snapshot's `entities` are the stored model-space list; in a
 * paper-space layout the edited entities are the layout's, which
 * Drawing.entities returns (and which Drawing.transact projects in for
 * its callback). Pure edit functions search `state.entities`, so they
 * must be given this view: against the raw snapshot a paper-space insert
 * is "not found" — DYNSET and Properties refused it, and a dynamic grip
 * drag resolved to nothing.
 */
function activeSpaceState(ed: Editor): DrawingState {
  const s = ed.doc.snapshot;
  const entities = ed.doc.entities;
  return entities === s.entities ? s : { ...s, entities };
}

/**
 * The parameter edit a grip drag amounts to, when the grip is a DYNAMIC
 * parameter grip (an insert grip with index >= 1 that resolves against the
 * current document): routed through core/parametric/grips.ts into
 * setDynamicParameter — the same path as a Properties or DYNSET edit.
 * Undefined for ordinary grips (including an insert's position grip).
 * Divergence, deliberate: moveGrip cannot make this edit (it is a pure
 * entity function with no block lookup and no document state), so dynamic
 * indices are resolved HERE, at the two pointer sites that would
 * otherwise hand them to moveGrip, and never reach it. Review R08 made
 * that guarantee total: the resolution runs against the ACTIVE SPACE's
 * state (a paper-space insert resolves at all), and
 * resolveDynamicGripDrag returns a refusal — never undefined — for an
 * unresolvable index on a dynamic insert, so no dynamic drag can fall
 * through to moving the whole INSERT.
 */
function dynamicDrag(ed: Editor, e: Entity, index: number, world: Point): DynamicGripEditResult | undefined {
  if (e.type !== 'insert' || index < 1) return undefined;
  return resolveDynamicGripDrag(activeSpaceState(ed), e.id, index, world);
}
