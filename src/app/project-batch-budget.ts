/** Aggregate retained-data bounds for a Windows project calculation; these are not RSS estimates. */
import type { DrawingState } from '../core/document';
import { entityGeometryWork, type Entity } from '../core/entities';

export const PROJECT_BATCH_LIMITS = Object.freeze({ sourceBytes: 128 * 1024 * 1024, outputBytes: 128 * 1024 * 1024, geometryWork: 4_000_000, characters: 16 * 1024 * 1024, nodes: 1_000_000, fields: 4_000_000 });
type Limits = { [K in keyof typeof PROJECT_BATCH_LIMITS]: number };
const exceeded = () => Object.assign(new Error('This project calculation exceeds the safe drawing-data budget. Use a smaller project batch.'), { code: 'ERR_PROJECT_BATCH_BUDGET' });

/** UTF-8 size without allocating another copy of a drawing's text. */
function utf8Size(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes++;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

export class ProjectBatchBudget {
  private readonly data = new WeakSet<object>();
  private readonly entities = new WeakSet<Entity>();
  private sourceBytes = 0;
  private outputBytes = 0;
  private geometryWork = 0;
  private characters = 0;
  private nodes = 0;
  private fields = 0;
  private readonly limits: Limits;

  constructor(options: Partial<Limits> = {}) {
    this.limits = { ...PROJECT_BATCH_LIMITS, ...options };
    for (const key of Object.keys(PROJECT_BATCH_LIMITS) as Array<keyof Limits>) if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] < 1 || this.limits[key] > PROJECT_BATCH_LIMITS[key]) throw new Error('Invalid project calculation budget.');
  }

  addSource(text: string): void {
    this.sourceBytes += utf8Size(text);
    if (this.sourceBytes > this.limits.sourceBytes) throw exceeded();
  }

  addOutput(text: string): void {
    this.outputBytes += utf8Size(text);
    if (this.outputBytes > this.limits.outputBytes) throw exceeded();
  }

  /** Shared immutable library definitions and unchanged geometry are charged once. */
  addState(state: DrawingState): void {
    const entity = (value: Entity) => {
      if (this.entities.has(value)) return;
      this.entities.add(value); this.geometryWork += entityGeometryWork(value);
      if (this.geometryWork > this.limits.geometryWork) throw exceeded();
    };
    for (const value of state.entities) entity(value);
    for (const block of Object.values(state.blocks)) for (const value of block.entities) entity(value);
    for (const layout of state.layouts ?? []) {
      for (const value of layout.entities) entity(value);
      for (const viewport of layout.viewports) if (viewport.clipBoundary) entity(viewport.clipBoundary);
    }
    // Imported arbitrary metadata also consumes memory, although it is not geometry.
    // Traversal is iterative and sharing-aware, with bounded fields before enumeration.
    const pending: object[] = [];
    const enter = (value: unknown) => {
      if (typeof value === 'string') { this.characters += value.length; if (this.characters > this.limits.characters) throw exceeded(); }
      else if (value && typeof value === 'object' && !this.data.has(value)) {
        this.data.add(value); if (++this.nodes > this.limits.nodes) throw exceeded(); pending.push(value);
      }
    };
    enter(state);
    while (pending.length) {
      const value = pending.pop()!;
      if (Array.isArray(value)) {
        this.fields += value.length; if (this.fields > this.limits.fields) throw exceeded();
        for (const item of value) enter(item);
      } else {
        for (const key in value) if (Object.hasOwn(value, key)) {
          if (++this.fields > this.limits.fields) throw exceeded();
          enter(key); enter((value as Record<string, unknown>)[key]);
        }
      }
    }
  }
}
