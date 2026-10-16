import { validateDrawingState, type Drawing } from '../core/document';
import type { AiDraftCapture } from './draft-context';
import type { CompiledProposal } from './draft-compiler';
import { AiError } from './types';

/**
 * The atomic apply boundary (docs/AI-ASSISTANT-M3.md). The ONLY draft code
 * path that mutates a drawing. Preflight runs the repository's existing
 * side-effect-free state validation; the commit is one synchronous
 * `transactDrawing` with no CAD edit intent (the eligible scope excludes
 * CAD-backed entities, so no graph transform exists to apply twice). The
 * transaction machinery creates exactly one undo step, clears redo and sets
 * the dirty flag; any throw before the commit leaves the document, its
 * metadata, history, dirty state and selection untouched.
 */
export function applyCompiledProposal(
  doc: Drawing,
  capture: AiDraftCapture,
  proposal: CompiledProposal,
): void {
  const previous = doc.snapshot;
  if (previous.space !== undefined) {
    throw new AiError('stale', 'Draft / Edit applies in the Model tab only.');
  }
  if (previous.entities === capture.state.entities && proposal.candidateEntities === previous.entities) {
    throw new AiError('invalid-plan', 'The proposal would not change the drawing.');
  }
  // The candidate carries the compiled entity array over the CURRENT state,
  // so every unrelated field (blocks, layers, header, CAD graph, layouts,
  // metadata) is preserved by reference exactly as it stands at commit time.
  const candidate = { ...previous, entities: proposal.candidateEntities };
  validateDrawingState(candidate, previous);
  doc.transactDrawing(() => candidate);
}
