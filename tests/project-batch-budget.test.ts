import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { ProjectBatchBudget, PROJECT_BATCH_LIMITS } from '../src/app/project-batch-budget';
import type { TextEntity } from '../src/core/entities';

const note: TextEntity = { id: 'n', type: 'text', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, height: 1, rotation: 0, align: 'left', text: 'test' };
describe('bounded aggregate project data', () => {
  it('checks decoded UTF-8 input and output without treating surrogate pairs as six bytes', () => {
    const budget = new ProjectBatchBudget({ sourceBytes: 4, outputBytes: 4 });
    budget.addSource('\ud83d\ude00'); budget.addOutput('\ud83d\ude00');
    expect(() => budget.addSource('x')).toThrow(/drawing-data budget/); expect(() => budget.addOutput('x')).toThrow(/drawing-data budget/);
    const unpaired = new ProjectBatchBudget({ sourceBytes: 3 }); unpaired.addSource('\ud800'); expect(() => unpaired.addSource('x')).toThrow(/drawing-data budget/);
  });
  it('charges shared immutable entities once, then rejects new aggregate geometry', () => {
    const state = new Drawing({ entities: [note] }).snapshot, budget = new ProjectBatchBudget({ geometryWork: 5 });
    budget.addState(state); budget.addState({ ...state, entities: [...state.entities] });
    expect(() => budget.addState({ ...state, entities: [{ ...note, id: 'different' }] })).toThrow(/drawing-data budget/);
  });
  it('charges arbitrary retained metadata strings separately from geometry', () => {
    const state = new Drawing().snapshot;
    expect(() => new ProjectBatchBudget({ characters: 10 }).addState({ ...state, meta: { arbitrary: 'long retained object metadata' } })).toThrow(/drawing-data budget/);
  });
  it('bounds retained object nodes and sparse-array fields before visiting them', () => {
    const state = new Drawing().snapshot;
    expect(() => new ProjectBatchBudget({ nodes: 2 }).addState(state)).toThrow(/drawing-data budget/);
    expect(() => new ProjectBatchBudget({ fields: 20 }).addState({ ...state, meta: { sparse: new Array(1000000) } })).toThrow(/drawing-data budget/);
  });
  it('allows lower test/application limits but refuses unbounded or nonfinite configuration', () => {
    for (const geometryWork of [0, Infinity, NaN, PROJECT_BATCH_LIMITS.geometryWork + 1]) expect(() => new ProjectBatchBudget({ geometryWork })).toThrow(/Invalid project/);
  });
});
