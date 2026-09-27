import type { Editor } from '../app/editor';
import type { Entity } from '../core/entities';
import { newId, translateEntity, entityBounds } from '../core/entities';
import * as g from '../core/geometry';

/**
 * In-application clipboard (Ctrl+C / Ctrl+X / Ctrl+V) like AutoCAD's COPYCLIP / PASTECLIP.
 * Entities are pasted at the cursor (or the original position when the cursor is off-canvas),
 * keeping their relative layout; the base point is the lower-left of the copied extents.
 */
export class EntityClipboard {
  private items: Entity[] = [];
  private base: g.Point = { x: 0, y: 0 };

  constructor(private editor: Editor) {}

  canPaste(): boolean {
    return this.items.length > 0;
  }

  copy(): boolean {
    const sel = this.editor.entitiesSelected();
    if (sel.length === 0) {
      this.editor.log('Nothing selected to copy.');
      return false;
    }
    this.items = sel.map((e) => ({ ...e }));
    let b: g.Bounds | null = null;
    for (const e of sel) b = g.unionBounds(b, entityBounds(e, this.editor.doc.lookupBlock));
    this.base = b ? { ...b.min } : { x: 0, y: 0 };
    this.editor.log(`${sel.length} object(s) copied to the clipboard.`);
    return true;
  }

  cut(): void {
    if (this.copy()) this.editor.runCommand('ERASE');
  }

  paste(at?: g.Point | null): void {
    if (this.items.length === 0) {
      this.editor.log('Clipboard is empty.');
      return;
    }
    const target = at ?? this.editor.cursorPosition() ?? this.base;
    const d = g.sub(target, this.base);
    const pasted = this.items.map((e) => ({ ...translateEntity(e, d), id: newId() }));
    this.editor.doc.addEntities(pasted);
    this.editor.selection = new Set(pasted.map((e) => e.id));
    this.editor.notify('selection');
    this.editor.render();
    this.editor.log(`${pasted.length} object(s) pasted.`);
  }
}
