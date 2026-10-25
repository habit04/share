/**
 * View and drafting toggles: the user settings applied to the viewport and snap settings (and
 * written back), the F3 / F7 .. F12 toggles, and zoom to the drawing extents.
 * The Editor's public methods delegate here (their documentation is on the Editor).
 */
import { lineweightDisplay, renderSettings } from '../../render/draw';
import { underlayBounds } from '../../core/underlay';
import { underlayPlacementOf } from '../../core/entities';
import * as g from '../../core/geometry';
import { saveSettings } from '../settings';
import type { Editor } from './editor';

export function applySettings(ed: Editor): void {
  const st = ed.settings;
  ed.viewport.settings.gridVisible = st.gridVisible;
  ed.viewport.settings.crosshairSize = st.crosshairSize;
  ed.snap.gridSnap = st.gridSnap;
  ed.snap.ortho = st.ortho;
  ed.snap.polar = st.polar;
  ed.snap.osnap = st.osnap;
  ed.dynamicInput = st.dynamicInput;
  lineweightDisplay.enabled = st.lineweightDisplay;
}

export function persistSettings(ed: Editor): void {
  ed.settings = {
    ...ed.settings,
    gridVisible: ed.viewport.settings.gridVisible,
    crosshairSize: ed.viewport.settings.crosshairSize,
    gridSnap: ed.snap.gridSnap,
    ortho: ed.snap.ortho,
    polar: ed.snap.polar,
    osnap: ed.snap.osnap,
    dynamicInput: ed.dynamicInput,
    lineweightDisplay: lineweightDisplay.enabled,
  };
  saveSettings(ed.settings);
}

export function toggle(ed: Editor, name: Parameters<Editor['toggle']>[0]): void {
  if (name === 'grid') ed.viewport.settings.gridVisible = !ed.viewport.settings.gridVisible;
  else if (name === 'lw') lineweightDisplay.enabled = !lineweightDisplay.enabled;
  else if (name === 'dyn') ed.dynamicInput = !ed.dynamicInput;
  else if (name === 'ortho') {
    ed.snap.ortho = !ed.snap.ortho;
    if (ed.snap.ortho) ed.snap.polar = false;
  } else if (name === 'polar') {
    ed.snap.polar = !ed.snap.polar;
    if (ed.snap.polar) ed.snap.ortho = false;
  } else ed.snap[name] = !ed.snap[name];
  const state =
    name === 'grid' ? ed.viewport.settings.gridVisible : name === 'lw' ? lineweightDisplay.enabled : name === 'dyn' ? ed.dynamicInput : ed.snap[name];
  ed.log(`<${name.toUpperCase()} ${state ? 'on' : 'off'}>`);
  ed.persistSettings();
  ed.notify('snap');
  ed.render();
}

export function zoomExtents(ed: Editor): void {
  let b = ed.doc.extents();
  // D4 (editor seam): doc.extents frames underlays by the stored
  // extent the session knows; a page size the LIVE display service
  // has already settled wins over it (page-size-first, the same
  // precedence as the plot channel). Residual: on first open,
  // documents.ts calls zoomExtents before any load has settled, so
  // that first fit still falls back to the stored extent — or the
  // unit frame when the definition carries none.
  const defs = ed.doc.snapshot.underlays;
  if (defs && renderSettings.underlaySource) {
    const hidden = new Set(ed.doc.snapshot.layers.filter((l) => !l.visible).map((l) => l.name));
    for (const e of ed.doc.entities) {
      if (e.type !== 'underlay' || hidden.has(e.layer)) continue;
      const page = renderSettings.underlaySource(e)?.page;
      if (!page) continue;
      const def = Object.values(defs).find((d) => (d.handle ?? '').trim().toUpperCase() === (e.definitionHandle ?? '').trim().toUpperCase());
      if (!def) continue;
      const ub = underlayBounds(underlayPlacementOf(e), { ...def, extent: page });
      b = g.unionBounds(b, { min: { x: ub.minX, y: ub.minY }, max: { x: ub.maxX, y: ub.maxY } });
    }
  }
  ed.viewport.zoomToBounds(b);
  ed.render();
  ed.notify('view');
}
