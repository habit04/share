import { AI_DRAFT_MAX_CONTEXT_BYTES, AI_MAX_QUESTION_CHARS } from './limits';
import { planToWire } from './draft-plan';
import type { CompiledProposal } from './draft-compiler';
import type { AiDraftCapture } from './draft-context';
import { AiError } from './types';

/**
 * Preview refinement (milestone 4, docs/AI-ASSISTANT-M4.md). A follow-up
 * instruction produces a COMPLETE REPLACEMENT PLAN evaluated against the
 * ORIGINAL captured drawing — never an incremental edit of the previous
 * preview, never a rebase onto a newer drawing. The refinement request is a
 * versioned, strictly whitelisted envelope containing only the original
 * bounded context, the original request, the latest accepted canonical
 * plan, bounded proposal-reference labels, and the follow-up text. The
 * envelope is what the panel displays before anything is sent, and its
 * byte size is capped by the same 96 KiB context limit as generation;
 * an oversized envelope is refused whole (nothing is truncated, no
 * authorization data is dropped) and the previous preview is preserved.
 */

export interface AiProposalLabel {
  readonly label: string;
  readonly summary: string;
}

/** Labels for the staged proposal's operations, aligned with its change list. */
export function proposalLabels(proposal: CompiledProposal): readonly AiProposalLabel[] {
  return proposal.changes.map((change) => ({ label: change.label, summary: change.summary }));
}

export interface AiRefineEnvelope {
  readonly envelopeJson: string;
  readonly followUp: string;
}

const utf8 = new TextEncoder();

export function buildRefineEnvelope(
  capture: AiDraftCapture,
  proposal: CompiledProposal,
  followUp: string,
): AiRefineEnvelope {
  const trimmed = typeof followUp === 'string' ? followUp.trim() : '';
  if (!trimmed) throw new AiError('invalid-question', 'Enter a follow-up instruction first.');
  if (trimmed.length > AI_MAX_QUESTION_CHARS) throw new AiError('invalid-question', 'The follow-up instruction is too long.');
  let originalContext: unknown;
  try { originalContext = JSON.parse(capture.contextJson); }
  catch { throw new AiError('invalid-context', 'The original draft context could not be read. Generate a new preview.'); }
  const envelope = {
    kind: 'jcad.ai.draft-refine-context',
    version: 1,
    originalPrompt: capture.prompt,
    followUp: trimmed,
    originalContext,
    currentPlan: { message: proposal.plan.message, operations: planToWire(proposal.plan).operations },
    proposalLabels: proposalLabels(proposal),
  };
  const envelopeJson = JSON.stringify(envelope);
  if (utf8.encode(envelopeJson).length > AI_DRAFT_MAX_CONTEXT_BYTES) {
    throw new AiError(
      'invalid-context',
      'The refinement context exceeds the AI context limit. Discard this preview and generate a smaller one instead.',
    );
  }
  return { envelopeJson, followUp: trimmed };
}

/** How the accepted replacement differs from the previous preview, per operation. */
export interface AiProposalDiff {
  readonly updated: readonly { readonly label: string; readonly before: string; readonly after: string }[];
  readonly added: readonly { readonly label: string; readonly summary: string }[];
  readonly removed: readonly { readonly label: string; readonly summary: string }[];
}

/**
 * Compare two compiled proposals. Operations are matched in two passes so
 * the description stays truthful when the plan changes length: first exact
 * content matches pair off as unchanged; then leftover operations of the
 * same kind pair in order as "changed"; anything still unpaired was added
 * or removed (labelled from the version it belongs to). Purely
 * presentational: it describes what the user is looking at and grants no
 * authority.
 */
export function diffProposalChanges(previous: CompiledProposal, next: CompiledProposal): AiProposalDiff {
  const updated: AiProposalDiff['updated'][number][] = [];
  const added: AiProposalDiff['added'][number][] = [];
  const removed: AiProposalDiff['removed'][number][] = [];
  const beforeOps = previous.plan.operations.map((op) => JSON.stringify(op));
  const afterOps = next.plan.operations.map((op) => JSON.stringify(op));
  const beforeTaken = new Array<boolean>(beforeOps.length).fill(false);
  const afterTaken = new Array<boolean>(afterOps.length).fill(false);
  for (let a = 0; a < afterOps.length; a++) {
    const b = beforeOps.findIndex((op, i) => !beforeTaken[i] && op === afterOps[a]);
    if (b >= 0) { beforeTaken[b] = true; afterTaken[a] = true; }
  }
  const leftoverBefore = beforeOps.map((_, i) => i).filter((i) => !beforeTaken[i]);
  const leftoverAfter = afterOps.map((_, i) => i).filter((i) => !afterTaken[i]);
  for (const a of [...leftoverAfter]) {
    const b = leftoverBefore.find((i) => previous.plan.operations[i]!.op === next.plan.operations[a]!.op);
    if (b === undefined) continue;
    leftoverBefore.splice(leftoverBefore.indexOf(b), 1);
    leftoverAfter.splice(leftoverAfter.indexOf(a), 1);
    updated.push({
      label: next.changes[a]!.label,
      before: previous.changes[b]!.summary,
      after: next.changes[a]!.summary,
    });
  }
  for (const a of leftoverAfter) added.push({ label: next.changes[a]!.label, summary: next.changes[a]!.summary });
  for (const b of leftoverBefore) removed.push({ label: previous.changes[b]!.label, summary: previous.changes[b]!.summary });
  return { updated, added, removed };
}
