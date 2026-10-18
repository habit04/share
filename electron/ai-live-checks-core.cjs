'use strict';

/**
 * Live-provider test harness core (docs/AI-LIVE-CHECKS.md).
 *
 * The pure, key-free core of the manual in-app live-checks harness:
 *
 *   - the fixed synthetic fixtures (selection snapshot, draft context,
 *     prompts) and the request builders that shape them into the exact
 *     requests the existing AI host service validates;
 *   - the fixed check sequence (probe -> ask -> draft -> refine) executed
 *     against an injected service facade;
 *   - the bounded result report and its plain-text rendering.
 *
 * The module imports nothing, touches no Electron API, no filesystem, no
 * network and no credential material. It never sees an API key: the
 * facade is the existing host service (`createAiService` in
 * electron/ai-host.cjs), which alone resolves the user's key inside the
 * main process. In tests the facade is a fake.
 *
 * Shapes mirror the corrected M4 baseline:
 *   - host validators aiRequest / aiDraftRequest / aiRefineRequest /
 *     draftBinding / validateDraftContext / copySnapshot
 *     (electron/ai-host.cjs);
 *   - context construction in src/ai/draft-context.ts;
 *   - envelope construction in src/ai/draft-refine.ts;
 *   - label names in src/ai/draft-plan.ts (planOperationLabels).
 */

const utf8 = new TextEncoder();
const utf8Length = (text) => utf8.encode(text).length;

/** Existing limits (src/ai/limits.ts), restated so the core stays import-free. */
const LIMITS = Object.freeze({
  maxQuestionChars: 2000,
  maxPlanBytes: 32 * 1024,
  maxMessageChars: 1000,
  maxEnvelopeBytes: 96 * 1024,
});

/**
 * The host's request-id pattern (electron/ai-host.cjs — aiRequest,
 * aiDraftRequest and aiRefineRequest all require it), restated so the
 * core stays import-free: 8–96 chars, alphanumeric + hyphens, starting
 * alphanumeric.
 */
const HOST_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{7,95}$/;

/**
 * runTags are 8–81 chars of the same alphabet. Composed ids are
 * `lc-<runTag>-<n>` (the tag plus 5 chars), so even the shortest
 * admitted tag yields a 13-char id — comfortably inside the host
 * pattern — and every composed id is additionally validated against
 * HOST_REQUEST_ID_PATTERN before use, so the core can never hand the
 * host an id it would reject.
 */
const RUNTAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{7,80}$/;

/** The fixed synthetic world every check runs against. Nothing here is user data. */
const FIXED = Object.freeze({
  docId: 'livecheck-doc',
  objectId: 'livecheck-line-1',
  layer: '0',
  question: 'How many objects are in the selection, and what is the length of the line? Answer briefly.',
  prompt: 'Create one circle centred at (50, 50) with radius 25.',
  followUp: "Change the circle's radius to 30.",
  originNote: 'Default origin is the World origin (0,0) unless the plan states explicit coordinates.',
  unitsNote: 'The drawing is UNITLESS. All plan values must be drawing units. If physical units were requested, return clarification asking for drawing-unit values; never infer a scale or convert units.',
  defaultsNote: 'Creations without an explicit layer use the default layer with exactly this appearance.',
});

/** Check metadata: the whole sequence, in order. `requires` gates execution. */
const CHECKS = Object.freeze([
  Object.freeze({ id: 'probe', title: 'Connection probe', requires: null }),
  Object.freeze({ id: 'ask', title: 'Ask about the synthetic selection', requires: null }),
  Object.freeze({ id: 'draft', title: 'Draft generate from the synthetic context', requires: null }),
  Object.freeze({ id: 'refine', title: 'Refine the generated plan', requires: 'draft' }),
]);

const OP_LABEL_NAMES = Object.freeze({
  createLine: 'Line',
  createCircle: 'Circle',
  createRectangle: 'Rectangle',
  move: 'Move',
  copy: 'Copy',
  rotate: 'Rotate',
  delete: 'Delete',
});

/**
 * The fixed synthetic selection snapshot: one line from (0,0) to (100,0)
 * on layer 0 in a unitless Model space. Built in exactly the shape the
 * host's copySnapshot() returns, with `serializedBytes` driven to the
 * same fixed point the host computes (it is accounting metadata the host
 * recomputes; the draft-context validator additionally requires the
 * embedded snapshot to deep-equal the host's rebuild, fixed point
 * included).
 */
function buildSyntheticSnapshot() {
  const snapshot = {
    kind: 'jcad.ai.selection-snapshot',
    version: 1,
    units: { insunits: 0, insunitsName: 'Unitless', lunits: 2, luprec: 4, auprec: 4 },
    space: { kind: 'model' },
    selection: { total: 1, included: 1, omittedCount: 0, omitted: [], omittedListTruncated: false },
    objects: [{
      id: FIXED.objectId,
      type: 'line',
      layer: FIXED.layer,
      geometry: { a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, length: 100 },
      bounds: { min: { x: 0, y: 0 }, max: { x: 100, y: 0 } },
    }],
    serializedBytes: 0,
  };
  let bytes = 0;
  do {
    snapshot.serializedBytes = bytes;
    bytes = utf8Length(JSON.stringify(snapshot));
  } while (snapshot.serializedBytes !== bytes);
  return snapshot;
}

/** The fixed Ask/Draft binding (renderer-shaped; the host whitelists it). */
function buildAskBinding() {
  return {
    sessionId: 0,
    docId: FIXED.docId,
    contentGeneration: 0,
    docRevision: 0,
    docLoadCount: 0,
    space: { layout: null, viewport: null },
    selectionIds: [FIXED.objectId],
  };
}

/**
 * The fixed draft binding. The fingerprint strings mirror how
 * src/ai/draft-context.ts composes them from the same fixed values
 * (units object, creation defaults, [interactionKey, bindingTargets]);
 * the host treats them as opaque bounded strings and never interprets
 * them. `configKey` is the caller's composition over the live state
 * (the panel composes the analogous key in ai-panel.ts draftConfigKey()).
 */
function buildDraftBinding(configKey) {
  return {
    ask: buildAskBinding(),
    unitsKey: JSON.stringify({ insunits: 0, lunits: 2, luprec: 4, auprec: 4 }),
    defaultsKey: JSON.stringify({ layer: FIXED.layer, color: 'ByLayer' }),
    eligibilityKey: JSON.stringify(['0', [{ id: FIXED.objectId, eligible: true }]]),
    configKey,
  };
}

/**
 * The fixed draft context object, in the exact key order and wording
 * captureDraftContext() produces for this synthetic drawing (unitless,
 * layer '0', ByLayer defaults, one eligible target). The context JSON is
 * JSON.stringify of this object, which is the canonical form the host's
 * validateDraftContext() requires.
 */
function buildDraftContext() {
  return {
    kind: 'jcad.ai.draft-context',
    version: 1,
    prompt: FIXED.prompt,
    coordinateFrame: 'World XY, Model tab',
    creationOrigin: { x: 0, y: 0, note: FIXED.originNote },
    units: { insunits: 0, name: 'Unitless', note: FIXED.unitsNote },
    creationDefaults: {
      layer: FIXED.layer,
      color: 'ByLayer',
      linetype: null,
      lineWeight: null,
      note: FIXED.defaultsNote,
    },
    permittedLayers: [FIXED.layer],
    targets: [{ id: FIXED.objectId, eligible: true }],
    selectionSnapshot: buildSyntheticSnapshot(),
  };
}

function buildDraftContextJson() {
  return JSON.stringify(buildDraftContext());
}

/** Fixed Ask request; destination pinned from the live state by the caller. */
function buildAskRequest({ requestId, provider, model }) {
  return {
    requestId,
    question: FIXED.question,
    snapshot: buildSyntheticSnapshot(),
    binding: buildAskBinding(),
    destination: { provider, model },
  };
}

/** Fixed Draft request; destination pins the live configuration generation. */
function buildDraftRequest({ requestId, provider, model, configGeneration, configKey }) {
  return {
    requestId,
    prompt: FIXED.prompt,
    contextJson: buildDraftContextJson(),
    binding: buildDraftBinding(configKey),
    destination: { provider, model, configGeneration },
  };
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : '?');
const pointText = (p) => (p && typeof p === 'object' ? `(${num(p.x)}, ${num(p.y)})` : '(?, ?)');
const targetCount = (op) => (Array.isArray(op.targetIds) ? op.targetIds.length : 0);

/**
 * Proposal labels for the refinement envelope: per-kind numbering in
 * plan order (mirrors planOperationLabels) with a bounded mechanical
 * summary built from the operation's own wire fields. Labels are model
 * reference aids only; the host validates their shape, never their text.
 */
function proposalLabelsFor(operations) {
  const counts = new Map();
  return operations.map((raw, index) => {
    const op = raw && typeof raw === 'object' ? raw : {};
    const kindName = OP_LABEL_NAMES[op.op] ?? 'Operation';
    const n = (counts.get(kindName) ?? 0) + 1;
    counts.set(kindName, n);
    let summary;
    switch (op.op) {
      case 'createLine':
        summary = `Create line from ${pointText(op.a)} to ${pointText(op.b)} on layer ${String(op.layer ?? '')}`;
        break;
      case 'createCircle':
        summary = `Create circle at ${pointText(op.center)} radius ${num(op.radius)} on layer ${String(op.layer ?? '')}`;
        break;
      case 'createRectangle':
        summary = `Create rectangle at ${pointText(op.origin)} ${num(op.width)} by ${num(op.height)} on layer ${String(op.layer ?? '')}`;
        break;
      case 'move':
        summary = `Move ${targetCount(op)} object(s) by (${num(op.dx)}, ${num(op.dy)})`;
        break;
      case 'copy':
        summary = `Copy ${targetCount(op)} object(s) by (${num(op.dx)}, ${num(op.dy)})`;
        break;
      case 'rotate':
        summary = `Rotate ${targetCount(op)} object(s) by ${num(op.angleDeg)} degrees`;
        break;
      case 'delete':
        summary = `Delete ${targetCount(op)} object(s)`;
        break;
      default:
        summary = `Operation ${index + 1}`;
    }
    return { label: `${kindName} ${n}`, summary: summary.slice(0, LIMITS.maxMessageChars) };
  });
}

/**
 * Extract the carried-forward plan from a service draft result
 * ({ value, configGeneration, usage?, providerUsage? }). Returns
 * { message, operations } detached by a JSON round trip, or null when
 * the draft did not produce a proposal (clarification / unsupported /
 * malformed) — in which case the Refine check is blocked, never faked.
 */
function extractDraftOutcome(draftResult) {
  const value = draftResult && typeof draftResult === 'object' ? draftResult.value : null;
  if (!value || typeof value !== 'object' || value.outcome !== 'proposal'
    || !Array.isArray(value.operations) || value.operations.length === 0
    || value.operations.length > 64) {
    return null;
  }
  let detached;
  try {
    detached = JSON.parse(JSON.stringify({ message: value.message ?? null, operations: value.operations }));
  } catch {
    return null;
  }
  if (utf8Length(JSON.stringify({ outcome: 'proposal', ...detached })) > LIMITS.maxPlanBytes) return null;
  return detached;
}

/**
 * Fixed Refine request. The envelope is the M4 seven-key canonical
 * object: original context + original prompt + the plan the Draft check
 * just produced + its labels + the fixed follow-up. JSON.stringify of
 * the constructed object is the canonical form aiRefineRequest()
 * requires (no whitespace, no duplicate keys, key order as built).
 *
 * The built envelope is measured against the 96 KiB envelope cap here,
 * in the core, and refused whole — this function returns null — when it
 * exceeds the cap: the same refuse-whole rule buildRefineEnvelope()
 * applies in src/ai/draft-refine.ts, restated as defence-in-depth (the
 * host enforces the same cap on arrival). The executor treats a null
 * return as Refine blocked: the request is never sent.
 */
function buildRefineRequest({ requestId, provider, model, configGeneration, configKey, draftOutcome }) {
  const envelope = {
    kind: 'jcad.ai.draft-refine-context',
    version: 1,
    originalPrompt: FIXED.prompt,
    followUp: FIXED.followUp,
    originalContext: buildDraftContext(),
    currentPlan: { message: draftOutcome.message, operations: draftOutcome.operations },
    proposalLabels: proposalLabelsFor(draftOutcome.operations),
  };
  const envelopeJson = JSON.stringify(envelope);
  if (utf8Length(envelopeJson) > LIMITS.maxEnvelopeBytes) return null;
  return {
    requestId,
    followUp: FIXED.followUp,
    envelopeJson,
    binding: buildDraftBinding(configKey),
    destination: { provider, model, configGeneration },
  };
}

/**
 * @typedef {object} LiveCheckEntry
 * @property {string} id
 * @property {string} title
 * @property {'pass' | 'fail' | 'blocked' | 'skipped' | 'cancelled'} status
 * @property {string} [detail]
 * @property {string} [errorKind]
 * @property {number} [durationMs]
 * @property {{ inputTokens?: number, outputTokens?: number }} [usage]
 */
/**
 * @typedef {object} LiveChecksReport
 * @property {string} kind
 * @property {number} version
 * @property {string} runTag
 * @property {string | null} provider
 * @property {string | null} model
 * @property {'pass' | 'fail' | 'refused' | 'cancelled'} status
 * @property {string | null} refusal
 * @property {LiveCheckEntry[]} checks
 * @property {{ providerCalls: number, durationMs: number, tokens?: { inputTokens: number, outputTokens: number } }} totals
 */

function normalizeError(cause) {
  const kind = cause && typeof cause.kind === 'string' && /^[a-z][a-z-]{0,63}$/.test(cause.kind)
    ? cause.kind
    : 'provider-failure';
  const message = cause && typeof cause.message === 'string' && cause.message.length > 0
    ? cause.message.slice(0, 500)
    : 'The provider request failed.';
  return { kind, message };
}

function pickTokens(source) {
  const usage = {};
  if (source && typeof source === 'object') {
    for (const field of ['inputTokens', 'outputTokens']) {
      const value = source[field];
      if (Number.isSafeInteger(value) && value >= 0) usage[field] = value;
    }
  }
  return usage;
}

/** Provider token counts from a service result, wherever the host surfaced them. */
function resultTokens(result) {
  return { ...pickTokens(result?.providerUsage), ...pickTokens(result?.usage) };
}

function outcomeDetail(outcome, message) {
  const text = typeof message === 'string' ? message.slice(0, LIMITS.maxMessageChars) : '';
  return text ? `${outcome}: ${text}` : outcome;
}

/**
 * Run the fixed sequence against a service facade:
 *
 *   facade = {
 *     getState(): Promise<state>,            // host state (keyPresent, enabled, ...)
 *     testConnection(signal): Promise<probe>,
 *     ask(request, signal): Promise<answer>,
 *     draft(request, signal): Promise<draftResult>,
 *     refine(request, signal): Promise<draftResult>,
 *   }
 *
 * In production the facade is a thin adapter over the existing host
 * service; in tests it is a scripted fake. The executor:
 *   - refuses before any provider call when the state preconditions
 *     fail (no key, disabled, credential/config problem, no facade);
 *   - pins provider/model/configGeneration from the state it read and
 *     fails the run 'stale' if a draft/refine result reports a different
 *     generation;
 *   - runs checks strictly sequentially, makes at most one provider call
 *     per check, never retries; Refine is blocked (not skipped) when the
 *     Draft check ended in a clarification/unsupported outcome, and
 *     every later check is skipped after the first hard failure or
 *     cancellation; a run with any blocked check never reports pass;
 *   - reports only bounded, content-free results (counts, kinds, the
 *     bounded clarification/unsupported message for the fixed synthetic
 *     prompt) — never key material, headers or provider bodies.
 *
 * options: { runTag (required, caller-minted, 8–81 chars — see
 * RUNTAG_PATTERN), signal?, now? }.
 */
async function runLiveChecks(facade, options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const signal = options.signal;
  const runTag = options.runTag;
  if (typeof runTag !== 'string' || !RUNTAG_PATTERN.test(runTag)) {
    throw new TypeError('runLiveChecks needs a runTag of 8–81 characters ([A-Za-z0-9-], starting with a letter or digit), so the request ids composed from it satisfy the host request-id pattern.');
  }
  const requestId = (n) => {
    const id = `lc-${runTag}-${n}`;
    if (!HOST_REQUEST_ID_PATTERN.test(id)) {
      throw new TypeError(`Composed request id ${JSON.stringify(id)} does not satisfy the host request-id pattern.`);
    }
    return id;
  };
  const started = now();
  /** @type {LiveChecksReport} */
  const report = {
    kind: 'jcad.ai.live-checks-report',
    version: 1,
    runTag,
    provider: null,
    model: null,
    status: 'refused',
    refusal: null,
    checks: [],
    totals: { providerCalls: 0, durationMs: 0 },
  };
  const finish = (status) => {
    // Report contract: a run with any blocked check never reports an
    // overall pass, whatever path produced the block — a check that
    // could not run means the sequence was not fully exercised.
    report.status = status === 'pass' && report.checks.some((check) => check.status === 'blocked')
      ? 'fail'
      : status;
    report.totals.durationMs = Math.max(0, now() - started);
    let inputTokens = 0;
    let outputTokens = 0;
    let sawTokens = false;
    for (const check of report.checks) {
      if (check.usage) {
        sawTokens = true;
        inputTokens += check.usage.inputTokens ?? 0;
        outputTokens += check.usage.outputTokens ?? 0;
      }
    }
    if (sawTokens) report.totals.tokens = { inputTokens, outputTokens };
    return report;
  };
  const skipRest = (fromIndex, reason) => {
    for (let i = fromIndex; i < CHECKS.length; i += 1) {
      report.checks.push({ id: CHECKS[i].id, title: CHECKS[i].title, status: 'skipped', detail: reason });
    }
  };

  if (!facade || ['getState', 'testConnection', 'ask', 'draft', 'refine'].some((m) => typeof facade[m] !== 'function')) {
    report.refusal = 'host-unavailable';
    return finish('refused');
  }

  let state;
  try {
    state = await facade.getState();
  } catch (cause) {
    report.refusal = normalizeError(cause).kind;
    return finish('refused');
  }
  report.provider = typeof state?.provider === 'string' ? state.provider : null;
  report.model = typeof state?.model === 'string' ? state.model : null;
  if (state?.keyPresent !== true) { report.refusal = 'no-key-configured'; return finish('refused'); }
  if (state?.enabled !== true) { report.refusal = 'provider-disabled'; return finish('refused'); }
  if (state?.credentialProblem) { report.refusal = 'credential-problem'; return finish('refused'); }
  if (state?.configProblem) { report.refusal = 'config-problem'; return finish('refused'); }
  if (!report.provider || !report.model || typeof state.configGeneration !== 'string' || !state.configGeneration) {
    report.refusal = 'no-destination';
    return finish('refused');
  }
  const { provider, model } = report;
  const configGeneration = state.configGeneration;
  const configKey = [configGeneration, provider, model, state.enabled, state.keyPresent, state.keySource ?? '', state.keyPersistence, state.credentialProblem ?? ''].join('|');

  let draftOutcome = null;
  let draftOutcomeKind = null; // 'clarification' | 'unsupported' when Draft ended in an outcome
  for (let i = 0; i < CHECKS.length; i += 1) {
    const check = CHECKS[i];
    if (signal?.aborted) {
      report.checks.push({ id: check.id, title: check.title, status: 'cancelled', detail: 'Cancelled before this check ran.' });
      skipRest(i + 1, 'Run cancelled.');
      return finish('cancelled');
    }
    if (check.requires === 'draft' && draftOutcome === null) {
      report.checks.push({
        id: check.id, title: check.title, status: 'blocked',
        detail: 'The Draft check did not produce a proposal to refine.',
      });
      continue;
    }
    // The Refine request is built before the check runs so that an
    // over-cap envelope (builder returns null) blocks the check locally:
    // the request is never sent and never counted as a provider call.
    let refineRequest = null;
    if (check.id === 'refine') {
      refineRequest = buildRefineRequest({ requestId: requestId(3), provider, model, configGeneration, configKey, draftOutcome });
      if (refineRequest === null) {
        report.checks.push({
          id: check.id, title: check.title, status: 'blocked',
          detail: 'The refinement envelope exceeds the 96 KiB limit, so no Refine request was sent.',
        });
        continue;
      }
    }
    const checkStarted = now();
    /** @type {LiveCheckEntry} */
    const entry = { id: check.id, title: check.title, status: 'fail' };
    try {
      report.totals.providerCalls += 1;
      if (check.id === 'probe') {
        const probe = await facade.testConnection(signal);
        entry.status = 'pass';
        entry.detail = `Model answered the probe${probe?.outputLimited ? ' (output-limited; connection verified)' : ''}.`;
        const tokens = pickTokens(probe);
        if (Object.keys(tokens).length > 0) entry.usage = tokens;
      } else if (check.id === 'ask') {
        const answer = await facade.ask(buildAskRequest({ requestId: requestId(1), provider, model }), signal);
        if (!answer || typeof answer.text !== 'string') throw Object.assign(new Error('The host returned an invalid answer.'), { kind: 'invalid-answer' });
        entry.status = 'pass';
        entry.detail = `Answer of ${answer.text.length} characters with ${Array.isArray(answer.references) ? answer.references.length : 0} reference(s).`;
        const tokens = resultTokens(answer);
        if (Object.keys(tokens).length > 0) entry.usage = tokens;
      } else if (check.id === 'draft' || check.id === 'refine') {
        const result = check.id === 'draft'
          ? await facade.draft(buildDraftRequest({ requestId: requestId(2), provider, model, configGeneration, configKey }), signal)
          : await facade.refine(refineRequest, signal);
        if (typeof result?.configGeneration === 'string' && result.configGeneration !== configGeneration) {
          throw Object.assign(new Error('The AI connection settings changed during the run.'), { kind: 'stale' });
        }
        const value = result?.value;
        if (value && value.outcome === 'proposal' && Array.isArray(value.operations)) {
          entry.status = 'pass';
          entry.detail = `Proposal with ${value.operations.length} operation(s).`;
          if (check.id === 'draft') draftOutcome = extractDraftOutcome(result);
        } else if (value && (value.outcome === 'clarification' || value.outcome === 'unsupported')) {
          entry.status = 'fail';
          entry.errorKind = value.outcome;
          entry.detail = outcomeDetail(value.outcome, value.message);
          if (check.id === 'draft') draftOutcomeKind = value.outcome;
        } else {
          throw Object.assign(new Error('The host returned an invalid draft result.'), { kind: 'invalid-plan' });
        }
        const tokens = resultTokens(result);
        if (Object.keys(tokens).length > 0) entry.usage = tokens;
      }
    } catch (cause) {
      const { kind, message } = normalizeError(cause);
      entry.status = kind === 'cancelled' ? 'cancelled' : 'fail';
      entry.errorKind = kind;
      entry.detail = message;
    }
    entry.durationMs = Math.max(0, now() - checkStarted);
    report.checks.push(entry);
    if (entry.status === 'cancelled') {
      skipRest(i + 1, 'Run cancelled.');
      return finish('cancelled');
    }
    if (entry.status === 'fail') {
      if (check.id === 'draft' && draftOutcomeKind) {
        // Draft ended in an outcome, not an error: Refine was prevented
        // by that upstream outcome, so it is blocked — not skipped
        // (docs/AI-LIVE-CHECKS.md §Failure semantics). Any other later
        // check is skipped as usual.
        for (let j = i + 1; j < CHECKS.length; j += 1) {
          const later = CHECKS[j];
          report.checks.push(later.requires === 'draft'
            ? {
              id: later.id, title: later.title, status: 'blocked',
              detail: `The Draft check ended with a ${draftOutcomeKind} outcome, so there is no proposal to refine.`,
            }
            : {
              id: later.id, title: later.title, status: 'skipped',
              detail: `Run stopped after the ${check.title} check failed.`,
            });
        }
        return finish('fail');
      }
      skipRest(i + 1, `Run stopped after the ${check.title} check failed.`);
      return finish('fail');
    }
  }
  return finish('pass');
}

const PROVIDER_LABELS = Object.freeze({ openai: 'OpenAI', anthropic: 'Anthropic Claude' });

/** Render the report as the plain text the panel shows (and Justin can copy). */
function formatReportText(report) {
  const label = PROVIDER_LABELS[report.provider] ?? report.provider ?? 'No provider';
  const lines = [`JCad live provider checks — ${label} · ${report.model ?? 'no model'}`];
  if (report.status === 'refused') {
    lines.push(`Result: REFUSED (${report.refusal ?? 'unknown reason'}) — no provider call was made.`);
    return lines.join('\n');
  }
  const verdict = { pass: 'PASS', fail: 'FAIL', cancelled: 'CANCELLED' }[report.status] ?? report.status.toUpperCase();
  const tokens = report.totals.tokens
    ? `, ${report.totals.tokens.inputTokens} input / ${report.totals.tokens.outputTokens} output tokens reported`
    : '';
  lines.push(`Result: ${verdict} — ${report.totals.providerCalls} provider call(s) in ${report.totals.durationMs} ms${tokens}.`);
  report.checks.forEach((check, index) => {
    const usage = check.usage ? ` [${check.usage.inputTokens ?? '?'} in / ${check.usage.outputTokens ?? '?'} out tokens]` : '';
    lines.push(`${index + 1}. ${check.title} — ${check.status.toUpperCase()}${check.errorKind ? ` (${check.errorKind})` : ''} — ${check.detail ?? ''}${usage}`);
  });
  return lines.join('\n');
}

module.exports = {
  CHECKS,
  FIXED,
  buildSyntheticSnapshot,
  buildAskBinding,
  buildDraftBinding,
  buildDraftContext,
  buildDraftContextJson,
  buildAskRequest,
  buildDraftRequest,
  buildRefineRequest,
  proposalLabelsFor,
  extractDraftOutcome,
  runLiveChecks,
  formatReportText,
};
