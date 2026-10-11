/**
 * Selection: what is selected (LIST, entitiesSelected), adding picked objects to the selection or
 * to a tool's "Select objects:" request, and which layers can be picked.
 * The Editor's public methods delegate here (their documentation is on the Editor).
 */
import * as g from '../../core/geometry';
import type { Entity } from '../../core/entities';
import type { Editor } from './editor';
import type { EditorInternals } from './internals';

export function listSelection(ed: Editor): void {
  if (ed.selection.size === 0) {
    ed.log('Nothing selected.');
    return;
  }
  for (const e of ed.doc.entities) {
    if (!ed.selection.has(e.id)) continue;
    switch (e.type) {
      case 'line':
        ed.log(`  LINE  Layer: "${e.layer}"  from (${e.a.x.toFixed(4)}, ${e.a.y.toFixed(4)}) to (${e.b.x.toFixed(4)}, ${e.b.y.toFixed(4)})  Length: ${g.dist(e.a, e.b).toFixed(4)}`);
        break;
      case 'circle':
        ed.log(`  CIRCLE  Layer: "${e.layer}"  center (${e.center.x.toFixed(4)}, ${e.center.y.toFixed(4)})  radius ${e.radius.toFixed(4)}`);
        break;
      case 'arc':
        ed.log(`  ARC  Layer: "${e.layer}"  center (${e.center.x.toFixed(4)}, ${e.center.y.toFixed(4)})  radius ${e.radius.toFixed(4)}`);
        break;
      case 'polyline':
        ed.log(`  LWPOLYLINE  Layer: "${e.layer}"  ${e.points.length} vertices${e.closed ? ' (closed)' : ''}`);
        break;
      case 'text':
        ed.log(`  TEXT  Layer: "${e.layer}"  "${e.text}"  height ${e.height}`);
        break;
      case 'insert':
        ed.log(`  INSERT  Layer: "${e.layer}"  block "${e.block}"  ${Object.entries(e.attributes).map(([k, v]) => `${k}="${v}"`).join(' ')}`);
        break;
    }
  }
}

export function entitiesSelected(ed: Editor): Entity[] {
  return ed.doc.entities.filter((e) => ed.selection.has(e.id));
}

export function toggleSelect(ed: Editor, st: EditorInternals, ids: string[], remove: boolean): void {
  const target = st.selReq ? st.selReq.ids : ed.selection;
  for (const id of ids) {
    if (remove) target.delete(id);
    else target.add(id);
  }
  if (st.selReq) {
    ed.selection = new Set(st.selReq.ids);
    ed.log(`${ids.length} found, ${st.selReq.ids.size} total`);
  }
  ed.notify('selection');
  ed.render();
}

export function hiddenLayers(ed: Editor): Set<string> {
  return new Set(ed.doc.layers.filter((l) => !l.visible).map((l) => l.name));
}

export function lockedLayers(ed: Editor): Set<string> {
  return new Set(ed.doc.layers.filter((l) => l.locked).map((l) => l.name));
}

export function pickAperture(ed: Editor): number {
  return ed.viewport.settings.pickBox * ed.viewport.worldPerPixel();
}
