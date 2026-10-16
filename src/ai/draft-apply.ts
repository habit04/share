import { prepareDrawingTransition, type Drawing } from '../core/document';
import type { AiDraftCapture } from './draft-context';
import { compiledProposalState, type CompiledProposal } from './draft-compiler';
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
  if (previous !== capture.state || doc.revision !== capture.binding.ask.docRevision || doc.loadCount !== capture.binding.ask.docLoadCount) {
    throw new AiError('stale', 'The drawing changed — generate again.');
  }
  if (previous.space !== undefined) {
    throw new AiError('stale', 'Draft / Edit applies in the Model tab only.');
  }
  const candidate = compiledProposalState(capture, proposal);
  if (!candidate || candidate.entities !== proposal.candidateEntities) {
    throw new AiError('invalid-plan', 'Generate a new preview before applying this proposal.');
  }
  if (prepareDrawingTransition(previous, candidate) !== candidate) {
    throw new AiError('invalid-plan', 'The proposal requires unsupported CAD metadata changes.');
  }
  try {
    doc.transactDrawing((current) => {
      if (current !== previous) throw new AiError('stale', 'The drawing changed — generate again.');
      return candidate;
    });
  } catch (cause) {
    // A subscriber can throw after the atomic commit. In that case the edit
    // succeeded and must be consumed, rather than inviting a duplicate retry.
    if (doc.snapshot !== candidate || doc.revision !== capture.binding.ask.docRevision + 1) throw cause;
  }
}
