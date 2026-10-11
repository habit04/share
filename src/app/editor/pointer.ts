/**
 * Pointer input: the snapped / tracked cursor point, rollover highlight, picking and selection
 * boxes, grip editing, panning with the middle button, wheel zoom and double-click editing.
 * The Editor's public methods delegate here (their documentation is on the Editor).
 */
import type { Point } from '../../core/geometry';
import * as g from '../../core/geometry';
import type { Entity } from '../../core/entities';
import { gripPoints, moveGrip } from '../../core/entities';
import { findObjectSnap, constrainDirection, snapToGrid, trackFromPoints, type SnapResult } from '../../core/snap';
import { pickEntity, selectByBox } from '../../core/selection';
import { PanTool } from '../../tools/edit';
import type { Editor } from './editor';
import { fallbackUi, type EditorInternals } from './internals';
import { makeContext, acceptPoint, updateCursorMode } from './prompter';
import { toggleSelect, hiddenLayers, lockedLayers, pickAperture } from './selection';

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
  const snap = wantSnap
    ? findObjectSnap(raw, ed.doc.entities, ed.doc.lookupBlock, ed.snap, aperture, st.overlay.trackFrom, hiddenLayers(ed))
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
  if (ed.snap.otrack && wantSnap) {
    const bases = st.overlay.trackFrom ? [...st.acquired, st.overlay.trackFrom] : st.acquired;
    const tr = trackFromPoints(raw, bases, ed.snap, aperture);
    if (tr) {
      st.overlay.trackPaths = tr.paths;
      return { world: tr.point, snap: { point: tr.point, kind: 'tracking' } };
    }
  }
  if (st.overlay.trackFrom) p = constrainDirection(st.overlay.trackFrom, p, ed.snap);
  p = snapToGrid(p, ed.snap);
  return { world: p, snap: null };
}

export function onMouseMove(ed: Editor, st: EditorInternals, ev: MouseEvent): void {
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

  if (st.gripDrag) {
    const moved = applyGrip(st.gripDrag.entity, st.gripDrag.index, world);
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
    ed.tool.onMove(world, makeContext(ed, st));
  } else if (ed.layoutInput.hoverBlocked?.(s)) {
    st.overlay.hover = null;
  } else {
    // rollover highlight
    const hit = pickEntity(ed.viewport.toWorld(s), ed.doc.entities, ed.doc.lookupBlock, pickAperture(ed), hiddenLayers(ed), lockedLayers(ed));
    st.overlay.hover = hit?.id ?? null;
    st.overlay.dynText = [];
  }
  ed.render();
  ed.notify('view');
}

export function onMouseDown(ed: Editor, st: EditorInternals, ev: MouseEvent): void {
  const s = ed.screenFromEvent(ev);
  st.lastMouse = s;
  if (ev.button === 1 || (ev.button === 0 && ed.tool instanceof PanTool && !st.selReq)) {
    ev.preventDefault();
    st.panning = true;
    return;
  }
  if (ev.button !== 0) return;
  if (!st.selReq && ed.layoutInput.mouseDown?.(s)) return;
  const { world } = resolveCursor(ed, st, s);
  if (ed.tool && !st.selReq) {
    acceptPoint(ed, st, world);
    return;
  }
  // Selection (default tool or selection request)
  const raw = ed.viewport.toWorld(s);
  // Grip editing: press on a grip of a selected entity to stretch it.
  if (!st.selReq && ed.selection.size > 0) {
    const gripTol = 6 * ed.viewport.worldPerPixel();
    for (const e of ed.doc.entities) {
      if (!ed.selection.has(e.id)) continue;
      const idx = gripPoints(e).findIndex((gp) => g.dist(gp, raw) <= gripTol);
      if (idx >= 0) {
        st.gripDrag = { entity: e, index: idx, start: raw };
        st.overlay.trackFrom = gripPoints(e)[idx]!;
        ed.setPrompt('** STRETCH **  Specify stretch point:');
        st.overlay.cursorMode = 'point';
        ed.render();
        return;
      }
    }
  }
  const hit = pickEntity(raw, ed.doc.entities, ed.doc.lookupBlock, pickAperture(ed), hiddenLayers(ed), lockedLayers(ed));
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
    const original = gripPoints(st.gripDrag.entity)[st.gripDrag.index];
    const moved = original && g.dist(original, world) > 1e-9 ? applyGrip(st.gripDrag.entity, st.gripDrag.index, world) : null;
    st.gripDrag = null;
    st.overlay.ghost = [];
    st.overlay.trackFrom = null;
    st.overlay.dynText = [];
    updateCursorMode(ed, st);
    ed.setPrompt('Type a command');
    if (moved) ed.doc.replaceEntities([moved]);
    ed.render();
    return;
  }
  if (st.dragStart && st.dragWorld) {
    const s = ed.screenFromEvent(ev);
    if (st.overlay.selectionBox) {
      const box = st.overlay.selectionBox;
      const bounds = g.boundsOfPoints([box.a, box.b])!;
      const found = selectByBox(bounds, box.mode, ed.doc.entities, ed.doc.lookupBlock, hiddenLayers(ed), lockedLayers(ed));
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

export function onDoubleClick(ed: Editor, ev: MouseEvent): void {
  if (ev.button === 1) {
    ed.zoomExtents();
    return;
  }
  if (ev.button !== 0 || ed.tool) return;
  if (ed.layoutInput.doubleClick?.(ed.screenFromEvent(ev))) return;
  const raw = ed.viewport.toWorld(ed.screenFromEvent(ev));
  const hit = pickEntity(raw, ed.doc.entities, ed.doc.lookupBlock, pickAperture(ed), hiddenLayers(ed), lockedLayers(ed));
  if (!hit) return;
  const ui = ed.ui ?? fallbackUi;
  if (hit.type === 'text') {
    void ui.textInput('Edit Text', 'Contents', hit.text).then((v) => {
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
    void ui
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
