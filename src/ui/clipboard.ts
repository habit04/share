import type { Editor } from '../app/editor';
import type { Entity, BlockDef } from '../core/entities';
import { newId, translateEntity, entityBounds } from '../core/entities';
import * as g from '../core/geometry';
import type { DrawingState } from '../core/document';
import { CadGraphError, type CadCloneBatch } from '../core/cad-graph';
import { cadTranslation, cadCloneBatch } from '../tools/cad-edits';

/**
 * In-application clipboard (Ctrl+C / Ctrl+X / Ctrl+V) like AutoCAD's COPYCLIP / PASTECLIP.
 * Entities are pasted at the cursor (or the original position when the cursor is off-canvas),
 * keeping their relative layout; the base point is the lower-left of the copied extents.
 */
export class EntityClipboard {
  private items: Entity[] = [];
  private sourceState: DrawingState | null = null;
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
    this.sourceState = this.editor.doc.snapshot;
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
    try {
      const source = this.sourceState!;
      const before = this.editor.doc.snapshot;
      const blocks: Record<string, BlockDef> = {}, copiedSources: Entity[] = [], copiedDefinitions: Entity[] = [];
      const anchorRemaps: NonNullable<CadCloneBatch['anchorRemaps']>[number][] = [];
      const sameDocument = source.cadGraph?.documentId && source.cadGraph.documentId === before.cadGraph?.documentId;
      const blockData = (block: BlockDef) => JSON.stringify(block, (key, value: unknown) => key === 'id' || key === 'cadIdentity' ? undefined : value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
      const visit = (entities: readonly Entity[]) => {
        for (const entity of entities) if (entity.type === 'insert' && !blocks[entity.block]) {
          const definition = source.blocks[entity.block];
          if (!definition) throw new CadGraphError('dependency', `Cannot paste: block "${entity.block}" is missing from the captured drawing.`);
          const existing = before.blocks[entity.block];
          if (existing) {
            if (!sameDocument && blockData(existing) !== blockData(definition)) throw new CadGraphError('dependency', `Cannot paste: the destination has a conflicting definition of block "${entity.block}".`);
            continue;
          }
          const copies = definition.entities.map(item => ({ ...item, id: newId() }));
          blocks[entity.block] = { ...definition, entities: copies };
          copiedSources.push(...definition.entities); copiedDefinitions.push(...copies);
          const anchor = { kind: 'table' as const, table: 'BLOCK_RECORD', name: entity.block };
          anchorRemaps.push({ from: anchor, to: anchor });
          visit(definition.entities);
        }
      };
      visit(this.items);
      const layers = [...before.layers], haveLayers = new Set(layers.map(layer => layer.name));
      for (const entity of [...this.items, ...copiedSources]) if (!haveLayers.has(entity.layer)) {
        const layer = source.layers.find(item => item.name === entity.layer);
        if (!layer) throw new CadGraphError('dependency', `Cannot paste: layer "${entity.layer}" is missing from the captured drawing.`);
        layers.push(layer); haveLayers.add(layer.name);
        const anchor = { kind: 'table' as const, table: 'LAYER', name: layer.name };
        anchorRemaps.push({ from: anchor, to: anchor });
      }
      const batches: CadCloneBatch[] = [];
      if (copiedSources.length || anchorRemaps.length) batches.push({ ...cadCloneBatch(copiedSources, copiedDefinitions), sourceState: source, anchorRemaps });
      batches.push({ ...cadCloneBatch(this.items, pasted, cadTranslation(d)), sourceState: source });
      this.editor.doc.transact(state => ({ ...state, layers, blocks: { ...state.blocks, ...blocks }, entities: [...state.entities, ...pasted] }), { cloneBatches: batches });
      const previousDiagnostics = before.cadGraph?.diagnostics?.length ?? 0;
      for (const diagnostic of (this.editor.doc.snapshot.cadGraph?.diagnostics ?? []).slice(previousDiagnostics, previousDiagnostics + 10)) this.editor.log(diagnostic.message);
    } catch (error) {
      if (!(error instanceof CadGraphError)) throw error;
      this.editor.log(`Paste canceled: ${error.message}`);
      return;
    }
    this.editor.selection = new Set(pasted.map((e) => e.id));
    this.editor.notify('selection');
    this.editor.render();
    this.editor.log(`${pasted.length} object(s) pasted.`);
  }
}
