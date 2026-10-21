'use strict';

/**
 * Host-side AI request service (docs/AI-ASSISTANT.md milestone 1,
 * docs/AI-ASSISTANT-M2.md milestone 2). Milestone 2 wires this module
 * through electron/main/ipc-ai.cjs, which registers guarded, sender-scoped
 * IPC channels: ask enqueues a request and renderer aborts cancel its
 * request id. Never register a request-only handler that loses aborts.
 * electron/main.cjs itself requires only ipc-ai.cjs, never this module.
 *
 * Shape follows electron/font-metrics-host.cjs: a pure validator that copies
 * only whitelisted, bounded fields; bounded concurrency; timeout; disposal;
 * usage counters that never contain content or keys.
 *
 * createAiService() owns the live configuration (createAiConfigStore) and
 * the credentials (createAiKeyStore): provider/model/credentials stay
 * host-side, no request leaves the machine before the user explicitly
 * enables Live AI, and key material is never returned to the renderer.
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

// Mirrors src/ai/limits.ts — tests pin both sides.
const AI_LIMITS = Object.freeze({
  maxObjects: 200,
  maxSnapshotBytes: 64 * 1024,
  maxQuestionChars: 2000,
  maxAnswerChars: 8000,
  maxReferences: 200,
  maxEnvelopeBytes: 128 * 1024,
  maxKeyChars: 512,
  maxTextChars: 500,
  maxAttributes: 32,
  maxTableCells: 64,
  maxSamplePoints: 16,
  maxOmittedListed: 100,
  // Milestone 3 (Draft / Edit) — mirrors the AI_DRAFT_* constants in limits.ts.
  maxDraftPlanBytes: 32 * 1024,
  maxDraftContextBytes: 96 * 1024,
  maxDraftOperations: 64,
  maxDraftTargetsPerOp: 200,
  maxDraftAffected: 400,
  maxDraftCreated: 200,
  maxDraftCoordinate: 1e7,
  maxDraftDimension: 1e6,
  maxDraftMessageChars: 1000,
});

class AiHostError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'AiHostError';
    this.kind = kind;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function boundedString(value, max, what) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new AiHostError('invalid-request', `Invalid ${what}.`);
  }
  return value;
}

function snapshotString(value, max, what, allowEmpty = true) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.length === 0)) {
    throw new AiHostError('invalid-request', `Invalid snapshot ${what}.`);
  }
  return value;
}

function finite(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AiHostError('invalid-request', 'Invalid snapshot number.');
  }
  return value;
}

function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AiHostError('invalid-request', 'Invalid snapshot count.');
  }
  return value;
}

function point(value) {
  if (!isPlainObject(value)) throw new AiHostError('invalid-request', 'Invalid snapshot point.');
  return { x: finite(value.x), y: finite(value.y) };
}

function boolean(value) {
  if (typeof value !== 'boolean') throw new AiHostError('invalid-request', 'Invalid snapshot flag.');
  return value;
}

function list(value, max, copy) {
  if (!Array.isArray(value) || value.length > max) {
    throw new AiHostError('invalid-request', 'Invalid snapshot list.');
  }
  return value.map(copy);
}

const GEOMETRY = Object.freeze({
  line: { a: point, b: point, length: finite },
  circle: { center: point, radius: finite, diameter: finite, circumference: finite, area: finite },
  arc: { center: point, radius: finite, startAngleDeg: finite, endAngleDeg: finite },
  polyline: { vertexCount: count, closed: boolean, vertices: points, length: finite },
  text: { position: point, height: finite, rotationDeg: finite },
  mtext: { position: point, height: finite, width: finite, rotationDeg: finite },
  insert: { block: text, position: point, rotationDeg: finite, scale: finite, scaleY: finite,
    mirror: boolean, columns: count, rows: count, columnSpacing: finite, rowSpacing: finite },
  ellipse: { center: point, majorAxis: point, ratio: finite, startParam: finite, endParam: finite },
  point: { position: point },
  xline: { base: point, direction: point },
  ray: { base: point, direction: point },
  spline: { degree: count, controlPointCount: count, closed: boolean, controlPoints: points },
  hatch: { pattern: text, solid: boolean, loopCount: count, angleDeg: finite, scale: finite },
  leader: { vertexCount: count, vertices: points, arrow: boolean },
  image: { position: point, sizeX: finite, sizeY: finite },
  dimension: { kind: text, p1: point, p2: point, linePoint: point },
  table: { position: point, rows: count, columns: count },
});

function text(value) { return snapshotString(value, AI_LIMITS.maxTextChars, 'text'); }
function points(value) { return list(value, AI_LIMITS.maxSamplePoints, point); }

function snapshotObject(value) {
  if (!isPlainObject(value) || typeof value.type !== 'string'
    || !Object.hasOwn(GEOMETRY, value.type) || !isPlainObject(value.geometry)) {
    throw new AiHostError('invalid-request', 'Invalid snapshot object.');
  }
  const geometry = {};
  for (const [key, copy] of Object.entries(GEOMETRY[value.type])) {
    if (Object.hasOwn(value.geometry, key)) geometry[key] = copy(value.geometry[key]);
  }
  const result = {
    id: snapshotString(value.id, AI_LIMITS.maxSnapshotBytes, 'id', false),
    type: value.type,
    layer: text(value.layer),
    geometry,
  };
  if (value.bounds !== undefined) {
    if (!isPlainObject(value.bounds)) throw new AiHostError('invalid-request', 'Invalid snapshot bounds.');
    result.bounds = { min: point(value.bounds.min), max: point(value.bounds.max) };
  }
  if (value.text !== undefined && ['text', 'mtext', 'leader', 'dimension'].includes(value.type)) result.text = text(value.text);
  if (value.attributes !== undefined && value.type === 'insert') {
    result.attributes = list(value.attributes, AI_LIMITS.maxAttributes, (attribute) => {
      if (!isPlainObject(attribute)) throw new AiHostError('invalid-request', 'Invalid snapshot attribute.');
      return {
        tag: text(attribute.tag), value: text(attribute.value),
        ...(attribute.hidden !== undefined ? { hidden: boolean(attribute.hidden) } : {}),
      };
    });
  }
  if (value.tableText !== undefined && value.type === 'table') result.tableText = list(value.tableText, AI_LIMITS.maxTableCells, text);
  if (value.notes !== undefined) result.notes = list(value.notes, 100, text);
  return result;
}

function copySnapshot(value) {
  if (!isPlainObject(value) || value.kind !== 'jcad.ai.selection-snapshot' || value.version !== 1
    || !isPlainObject(value.units) || !isPlainObject(value.space) || !isPlainObject(value.selection)) {
    throw new AiHostError('invalid-request', 'Invalid snapshot.');
  }
  const units = value.units;
  const space = value.space.kind === 'model' ? { kind: 'model' }
    : value.space.kind === 'layout' ? {
      kind: 'layout', layout: snapshotString(value.space.layout, AI_LIMITS.maxSnapshotBytes, 'layout'),
      ...(value.space.viewport !== undefined ? { viewport: snapshotString(value.space.viewport, AI_LIMITS.maxSnapshotBytes, 'viewport') } : {}),
    } : null;
  if (!space) throw new AiHostError('invalid-request', 'Invalid snapshot space.');
  const objects = list(value.objects, AI_LIMITS.maxObjects, snapshotObject);
  if (new Set(objects.map((object) => object.id)).size !== objects.length) {
    throw new AiHostError('invalid-request', 'Duplicate snapshot object id.');
  }
  const selection = value.selection;
  const total = count(selection.total), included = count(selection.included), omittedCount = count(selection.omittedCount);
  if (included !== objects.length || total - included !== omittedCount) {
    throw new AiHostError('invalid-request', 'Invalid snapshot selection counts.');
  }
  const omitted = list(selection.omitted, AI_LIMITS.maxOmittedListed, (item) => {
    if (!isPlainObject(item) || !['unsupported-object', 'missing-object', 'unsupported-type', 'object-limit', 'byte-limit'].includes(item.reason)) {
      throw new AiHostError('invalid-request', 'Invalid snapshot omission.');
    }
    return { id: snapshotString(item.id, AI_LIMITS.maxSnapshotBytes, 'omitted id'), reason: item.reason };
  });
  if (omitted.reduce((bytes, item) => bytes + Buffer.byteLength(JSON.stringify(item), 'utf8'), 0) > AI_LIMITS.maxSnapshotBytes / 4) {
    throw new AiHostError('invalid-request', 'Snapshot omission metadata exceeds the size limit.');
  }
  if (omitted.length > omittedCount || boolean(selection.omittedListTruncated) !== (omitted.length < omittedCount)) {
    throw new AiHostError('invalid-request', 'Invalid snapshot omissions.');
  }
  return {
    kind: 'jcad.ai.selection-snapshot', version: 1,
    units: { insunits: count(units.insunits), insunitsName: snapshotString(units.insunitsName, 64, 'units'),
      lunits: count(units.lunits), luprec: count(units.luprec), auprec: count(units.auprec) },
    space,
    selection: { total, included, omittedCount, omitted, omittedListTruncated: selection.omittedListTruncated },
    objects,
  };
}

/**
 * Validate an ask envelope from the renderer and return a fresh object with
 * only whitelisted fields, including per-type geometry. The snapshot is
 * rebuilt and re-measured; unrecognised fields never reach the transport.
 * serializedBytes is accounting metadata, never trusted: recompute it over
 * the canonical wire JSON including that field, as the renderer does.
 */
function aiRequest(value) {
  if (!isPlainObject(value)) throw new AiHostError('invalid-request', 'Invalid AI request.');
  let envelopeBytes;
  try {
    envelopeBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    throw new AiHostError('invalid-request', 'AI request is not serializable.');
  }
  if (envelopeBytes > AI_LIMITS.maxEnvelopeBytes) {
    throw new AiHostError('invalid-request', 'AI request exceeds the size limit.');
  }
  // Integer ids (milestone 1) and string ids (milestone 2: the renderer
  // mints `<page-instance salt>-<counter>`, docs/AI-ASSISTANT-M2.md) are
  // both accepted; the job maps key them as-is, so 5 and '5' are distinct.
  const requestId = value.requestId;
  if (!((Number.isSafeInteger(requestId) && requestId >= 0)
    || (typeof requestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{7,95}$/.test(requestId)))) {
    throw new AiHostError('invalid-request', 'Invalid request id.');
  }
  const question = boundedString(value.question, AI_LIMITS.maxQuestionChars, 'question');
  let destination;
  if (value.destination !== undefined) {
    if (!isPlainObject(value.destination) || !AI_PROVIDERS.includes(value.destination.provider)
      || !validateAiModel(value.destination.model)) throw new AiHostError('invalid-request', 'Invalid AI destination.');
    destination = { provider: value.destination.provider, model: value.destination.model };
  }

  const snapshot = copySnapshot(value.snapshot);
  let snapshotBytes = 0;
  do {
    snapshot.serializedBytes = snapshotBytes;
    snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  } while (snapshot.serializedBytes !== snapshotBytes);
  if (snapshotBytes > AI_LIMITS.maxSnapshotBytes) {
    throw new AiHostError('invalid-request', 'Snapshot exceeds the size limit.');
  }

  const binding = value.binding;
  if (!isPlainObject(binding)
    || !Number.isSafeInteger(binding.sessionId)
    || typeof binding.docId !== 'string' || binding.docId.length > AI_LIMITS.maxEnvelopeBytes
    || !Number.isSafeInteger(binding.contentGeneration)
    || !Number.isSafeInteger(binding.docRevision)
    || !Array.isArray(binding.selectionIds)
    || binding.selectionIds.length > AI_LIMITS.maxEnvelopeBytes
    || binding.selectionIds.some((id) => typeof id !== 'string' || id.length > AI_LIMITS.maxEnvelopeBytes)) {
    throw new AiHostError('invalid-request', 'Invalid request binding.');
  }

  return {
    requestId: value.requestId,
    question,
    ...(destination ? { destination } : {}),
    snapshot,
    snapshotBytes,
    binding: {
      sessionId: binding.sessionId,
      docId: binding.docId,
      contentGeneration: binding.contentGeneration,
      docRevision: binding.docRevision,
      selectionCount: binding.selectionIds.length,
    },
  };
}

/** Validate a transport answer before it is allowed back to the renderer. */
function aiAnswer(value) {
  if (!isPlainObject(value) || typeof value.text !== 'string' || value.text.length === 0) {
    throw new AiHostError('invalid-answer', 'The provider returned an invalid answer.');
  }
  if (value.text.length > AI_LIMITS.maxAnswerChars) {
    throw new AiHostError('output-too-large', 'The provider answer exceeds the output limit.');
  }
  const references = Array.isArray(value.references)
    ? value.references.slice(0, AI_LIMITS.maxReferences).filter((id) => typeof id === 'string'
      && id.length <= AI_LIMITS.maxSnapshotBytes && Buffer.byteLength(id, 'utf8') <= AI_LIMITS.maxSnapshotBytes)
    : [];
  if (Buffer.byteLength(JSON.stringify({ text: value.text, references }), 'utf8') > AI_LIMITS.maxEnvelopeBytes) {
    throw new AiHostError('output-too-large', 'The provider answer exceeds the output size limit.');
  }
  const result = { text: value.text, references };
  // Provider-reported token usage rides along only as bounded counts;
  // anything malformed is dropped field by field, never trusted.
  if (isPlainObject(value.providerUsage)) {
    const providerUsage = {};
    for (const field of ['inputTokens', 'outputTokens']) {
      const tokens = value.providerUsage[field];
      if (Number.isSafeInteger(tokens) && tokens >= 0) providerUsage[field] = tokens;
    }
    if (Object.keys(providerUsage).length > 0) result.providerUsage = providerUsage;
  }
  return result;
}

function draftContextRecord(value, fields) {
  if (!isPlainObject(value) || Object.keys(value).length !== fields.length
    || fields.some((field) => !Object.hasOwn(value, field))) {
    throw new AiHostError('invalid-request', 'Invalid draft context fields.');
  }
  return value;
}

/** Validate without rewriting: accepted context bytes remain exactly as previewed. */
function validateDraftContext(json, prompt) {
  let context;
  try { context = JSON.parse(json); }
  catch { throw new AiHostError('invalid-request', 'Invalid draft context JSON.'); }
  if (JSON.stringify(context) !== json) {
    throw new AiHostError('invalid-request', 'Draft context must use canonical JSON.');
  }
  draftContextRecord(context, ['kind', 'version', 'prompt', 'coordinateFrame', 'creationOrigin', 'units',
    'creationDefaults', 'permittedLayers', 'targets', 'selectionSnapshot']);
  if (context.kind !== 'jcad.ai.draft-context' || context.version !== 1 || context.prompt !== prompt
    || context.coordinateFrame !== 'World XY, Model tab') {
    throw new AiHostError('invalid-request', 'Invalid draft context.');
  }
  const origin = draftContextRecord(context.creationOrigin, ['x', 'y', 'note']);
  if (finite(origin.x) !== 0 || finite(origin.y) !== 0) throw new AiHostError('invalid-request', 'Invalid draft origin.');
  snapshotString(origin.note, 1000, 'origin note');
  const units = draftContextRecord(context.units, ['insunits', 'name', 'note']);
  count(units.insunits); text(units.name); snapshotString(units.note, 1000, 'unit note');
  const defaults = draftContextRecord(context.creationDefaults, ['layer', 'color', 'linetype', 'lineWeight', 'note']);
  snapshotString(defaults.layer, 512, 'creation layer');
  if (defaults.color !== 'ByLayer') finite(defaults.color);
  if (defaults.linetype !== null) snapshotString(defaults.linetype, 512, 'creation linetype', false);
  if (defaults.lineWeight !== null) finite(defaults.lineWeight);
  snapshotString(defaults.note, 1000, 'creation note');
  list(context.permittedLayers, AI_LIMITS.maxObjects + 1, (layer) => snapshotString(layer, 512, 'permitted layer'));
  list(context.targets, AI_LIMITS.maxObjects, (target) => {
    const item = draftContextRecord(target, target?.eligible === false ? ['id', 'eligible', 'reason'] : ['id', 'eligible']);
    snapshotString(item.id, AI_LIMITS.maxDraftContextBytes, 'target id', false);
    boolean(item.eligible);
    if (!item.eligible) snapshotString(item.reason, 1000, 'target reason');
    return item;
  });
  const snapshot = copySnapshot(context.selectionSnapshot);
  let bytes = 0;
  do {
    snapshot.serializedBytes = bytes;
    bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  } while (snapshot.serializedBytes !== bytes);
  if (bytes > AI_LIMITS.maxSnapshotBytes || snapshot.space.kind !== 'model'
    || !isDeepStrictEqual(snapshot, context.selectionSnapshot)) {
    throw new AiHostError('invalid-request', 'Invalid draft selection snapshot.');
  }
  if (units.insunits !== snapshot.units.insunits) throw new AiHostError('invalid-request', 'Inconsistent draft units.');
  return context;
}

/**
 * Validate a draft envelope from the renderer (milestone 3,
 * docs/AI-ASSISTANT-M3.md) and return a fresh object with only whitelisted
 * fields, mirroring aiRequest(). The context JSON is the exact text the
 * panel previewed: its whitelist is checked but accepted bytes are never
 * rebuilt or re-serialized host-side. The binding is the draft binding
 * (AiDraftBinding): the ask binding whitelisted as in aiRequest() plus the
 * units/defaults/eligibility/configuration fingerprint strings, each
 * bounded. Fingerprint contents are renderer bookkeeping — the host never
 * interprets them; it only carries the whitelist through.
 */
function aiDraftRequest(value) {
  if (!isPlainObject(value)) throw new AiHostError('invalid-request', 'Invalid AI draft request.');
  let envelopeBytes;
  try {
    envelopeBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    throw new AiHostError('invalid-request', 'AI draft request is not serializable.');
  }
  if (envelopeBytes > AI_LIMITS.maxEnvelopeBytes) {
    throw new AiHostError('invalid-request', 'AI draft request exceeds the size limit.');
  }
  const requestId = value.requestId;
  if (!((Number.isSafeInteger(requestId) && requestId >= 0)
    || (typeof requestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{7,95}$/.test(requestId)))) {
    throw new AiHostError('invalid-request', 'Invalid request id.');
  }
  const prompt = boundedString(value.prompt, AI_LIMITS.maxQuestionChars, 'draft prompt');
  if (typeof value.contextJson !== 'string' || value.contextJson.length === 0) {
    throw new AiHostError('invalid-request', 'Invalid draft context.');
  }
  const contextBytes = Buffer.byteLength(value.contextJson, 'utf8');
  if (contextBytes > AI_LIMITS.maxDraftContextBytes) {
    throw new AiHostError('invalid-request', 'Draft context exceeds the size limit.');
  }
  const context = validateDraftContext(value.contextJson, prompt);
  let destination;
  if (value.destination !== undefined) {
    if (!isPlainObject(value.destination) || !AI_PROVIDERS.includes(value.destination.provider)
      || !validateAiModel(value.destination.model)) throw new AiHostError('invalid-request', 'Invalid AI destination.');
    const configGeneration = value.destination.configGeneration;
    if (typeof configGeneration !== 'string' || !/^[a-f0-9-]{36}:\d+$/.test(configGeneration)) {
      throw new AiHostError('invalid-request', 'Invalid AI configuration generation.');
    }
    destination = { provider: value.destination.provider, model: value.destination.model, configGeneration };
  }
  return {
    requestId: value.requestId,
    prompt,
    contextJson: value.contextJson,
    contextBytes,
    ...(destination ? { destination } : {}),
    binding: draftBinding(value.binding, context.targets),
  };
}

/**
 * Validate the draft binding shared by draft and refinement requests
 * (milestones 3–4) and return its whitelist: the ask binding (selection
 * carried as a count) plus the units/defaults/eligibility/configuration
 * fingerprint strings, each bounded. The selection must be exactly the
 * validated context's target set — an id the context does not disclose
 * is not an authorized target, and a disclosed target the binding omits
 * is an inconsistency. Fingerprint contents are renderer bookkeeping —
 * the host never interprets them; it only carries the whitelist through.
 */
function draftBinding(value, targets) {
  if (!isPlainObject(value) || !isPlainObject(value.ask)) {
    throw new AiHostError('invalid-request', 'Invalid draft binding.');
  }
  const ask = value.ask;
  if (!Number.isSafeInteger(ask.sessionId)
    || typeof ask.docId !== 'string' || ask.docId.length > AI_LIMITS.maxEnvelopeBytes
    || !Number.isSafeInteger(ask.contentGeneration)
    || !Number.isSafeInteger(ask.docRevision)
    || !Array.isArray(ask.selectionIds)
    || ask.selectionIds.length > AI_LIMITS.maxEnvelopeBytes
    || ask.selectionIds.some((id) => typeof id !== 'string' || id.length > AI_LIMITS.maxEnvelopeBytes)) {
    throw new AiHostError('invalid-request', 'Invalid draft binding.');
  }
  if (!isPlainObject(ask.space) || ask.space.layout !== null || ask.space.viewport !== null
    || targets.length !== ask.selectionIds.length
    || new Set(ask.selectionIds).size !== ask.selectionIds.length
    || targets.some((target) => !ask.selectionIds.includes(target.id))
    || new Set(targets.map((target) => target.id)).size !== targets.length) {
    throw new AiHostError('invalid-request', 'Inconsistent draft selection binding.');
  }
  const fingerprints = {};
  for (const field of ['unitsKey', 'defaultsKey', 'eligibilityKey', 'configKey']) {
    const fingerprint = value[field];
    // A fingerprint may be empty (an empty selection has no eligibility
    // entries); it is a bounded opaque string, never content.
    if (typeof fingerprint !== 'string' || fingerprint.length > AI_LIMITS.maxEnvelopeBytes
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(fingerprint)) {
      throw new AiHostError('invalid-request', 'Invalid draft binding.');
    }
    fingerprints[field] = fingerprint;
  }
  return {
    ask: {
      sessionId: ask.sessionId,
      docId: ask.docId,
      contentGeneration: ask.contentGeneration,
      docRevision: ask.docRevision,
      selectionCount: ask.selectionIds.length,
    },
    ...fingerprints,
  };
}

/** The refinement envelope's top-level keys, in order (src/ai/draft-refine.ts). */
const REFINE_ENVELOPE_KEYS = Object.freeze([
  'kind', 'version', 'originalPrompt', 'followUp', 'originalContext', 'currentPlan', 'proposalLabels',
]);
// Mirrors planOperationLabels() in src/ai/draft-plan.ts. These references
// describe the current plan only; they never authorize a drawing target.
const REFINE_LABEL_NAMES = new Map([
  ['createLine', 'Line'], ['createCircle', 'Circle'], ['createRectangle', 'Rectangle'],
  ['move', 'Move'], ['copy', 'Copy'], ['rotate', 'Rotate'], ['delete', 'Delete'],
]);

/**
 * Validate a refinement envelope from the renderer (milestone 4,
 * docs/AI-ASSISTANT-M4.md) and return a fresh object with only whitelisted
 * fields, mirroring aiDraftRequest(). The refinement envelope JSON is the
 * exact text the panel previewed: it must be canonical JSON carrying
 * exactly the whitelisted top-level keys — the original bounded context
 * (re-validated in full through validateDraftContext, so the nested
 * whitelist and the selection accounting apply unchanged), the original
 * prompt, the latest accepted plan (validated against the plan contract:
 * a malformed CURRENT plan is a bad request, 'invalid-request', never an
 * 'invalid-plan' result) and bounded proposal labels. Accepted envelope
 * bytes are never rebuilt or re-serialized host-side.
 */
function aiRefineRequest(value) {
  if (!isPlainObject(value)) throw new AiHostError('invalid-request', 'Invalid AI refinement request.');
  let envelopeBytes;
  try {
    envelopeBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    throw new AiHostError('invalid-request', 'AI refinement request is not serializable.');
  }
  if (envelopeBytes > AI_LIMITS.maxEnvelopeBytes) {
    throw new AiHostError('invalid-request', 'AI refinement request exceeds the size limit.');
  }
  const requestId = value.requestId;
  if (!((Number.isSafeInteger(requestId) && requestId >= 0)
    || (typeof requestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{7,95}$/.test(requestId)))) {
    throw new AiHostError('invalid-request', 'Invalid request id.');
  }
  const followUp = boundedString(value.followUp, AI_LIMITS.maxQuestionChars, 'follow-up');
  if (typeof value.envelopeJson !== 'string' || value.envelopeJson.length === 0) {
    throw new AiHostError('invalid-request', 'Invalid refinement context.');
  }
  const refineBytes = Buffer.byteLength(value.envelopeJson, 'utf8');
  if (refineBytes > AI_LIMITS.maxDraftContextBytes) {
    throw new AiHostError('invalid-request', 'Refinement context exceeds the size limit.');
  }
  let envelope;
  try { envelope = JSON.parse(value.envelopeJson); }
  catch { throw new AiHostError('invalid-request', 'Invalid refinement context JSON.'); }
  if (JSON.stringify(envelope) !== value.envelopeJson) {
    throw new AiHostError('invalid-request', 'Refinement context must use canonical JSON.');
  }
  if (!isPlainObject(envelope)) throw new AiHostError('invalid-request', 'Invalid refinement context.');
  const keys = Object.keys(envelope);
  if (keys.length !== REFINE_ENVELOPE_KEYS.length
    || keys.some((key, index) => key !== REFINE_ENVELOPE_KEYS[index])) {
    throw new AiHostError('invalid-request', 'Invalid refinement context fields.');
  }
  if (envelope.kind !== 'jcad.ai.draft-refine-context' || envelope.version !== 1) {
    throw new AiHostError('invalid-request', 'Invalid refinement context.');
  }
  if (envelope.followUp !== followUp) {
    throw new AiHostError('invalid-request', 'Refinement follow-up does not match the envelope.');
  }
  const originalPrompt = boundedString(envelope.originalPrompt, AI_LIMITS.maxQuestionChars, 'original prompt');
  // The nested context passes the draft-context validator whole: it checks
  // the context's own prompt against the envelope's original prompt and the
  // selection/snapshot accounting, exactly as at generation time.
  const originalContext = validateDraftContext(JSON.stringify(envelope.originalContext), originalPrompt);
  const currentPlan = envelope.currentPlan;
  if (!isPlainObject(currentPlan) || Object.keys(currentPlan).length !== 2
    || !Object.hasOwn(currentPlan, 'message') || !Object.hasOwn(currentPlan, 'operations')) {
    throw new AiHostError('invalid-request', 'Invalid current plan.');
  }
  if (currentPlan.message !== null && typeof currentPlan.message !== 'string') {
    throw new AiHostError('invalid-request', 'Invalid current plan message.');
  }
  const planValue = { outcome: 'proposal', message: currentPlan.message ?? null, operations: currentPlan.operations };
  let planBytes;
  try { planBytes = Buffer.byteLength(JSON.stringify(planValue), 'utf8'); }
  catch { throw new AiHostError('invalid-request', 'Invalid current plan.'); }
  if (planBytes > AI_LIMITS.maxDraftPlanBytes) {
    throw new AiHostError('invalid-request', 'The current plan exceeds the size limit.');
  }
  let parsed;
  try {
    parsed = parseDraftResponse(planValue);
  } catch {
    throw new AiHostError('invalid-request', 'The current plan is not a valid draft plan.');
  }
  if (parsed.kind !== 'plan' || !parsed.plan) throw new AiHostError('invalid-request', 'Invalid current plan.');
  const eligible = new Set(originalContext.targets.filter((target) => target.eligible).map((target) => target.id));
  const disclosed = new Set(originalContext.selectionSnapshot.objects.map((object) => object.id));
  const layers = new Set(originalContext.permittedLayers);
  for (const operation of parsed.plan.operations) {
    if ('targetIds' in operation) {
      if (!operation.targetIds || operation.targetIds.some((id) => !eligible.has(id) || !disclosed.has(id))) {
        throw new AiHostError('invalid-request', 'The current plan targets an object outside the original eligible selection.');
      }
    } else if (!layers.has(operation.layer ?? originalContext.creationDefaults.layer)) {
      throw new AiHostError('invalid-request', 'The current plan uses an undisclosed creation layer.');
    }
  }
  const labels = list(envelope.proposalLabels, AI_LIMITS.maxDraftOperations, (item) => {
    if (!isPlainObject(item) || Object.keys(item).length !== 2
      || !Object.hasOwn(item, 'label') || !Object.hasOwn(item, 'summary')) {
      throw new AiHostError('invalid-request', 'Invalid proposal label.');
    }
    snapshotString(item.label, 64, 'proposal label', false);
    // A valid edit summary names up to 200 targets and can exceed the
    // provider message limit. The exact envelope's 96 KiB byte cap bounds
    // this local display text without silently truncating it.
    snapshotString(item.summary, AI_LIMITS.maxDraftContextBytes, 'proposal label summary');
    return item;
  });
  if (labels.length !== parsed.plan.operations.length) {
    throw new AiHostError('invalid-request', 'Proposal labels do not match the current plan.');
  }
  const labelCounts = new Map();
  for (const [index, operation] of parsed.plan.operations.entries()) {
    const next = (labelCounts.get(operation.op) ?? 0) + 1;
    labelCounts.set(operation.op, next);
    if (labels[index].label !== `${REFINE_LABEL_NAMES.get(operation.op)} ${next}`) {
      throw new AiHostError('invalid-request', 'Proposal labels do not match the current plan.');
    }
  }
  let destination;
  if (value.destination !== undefined) {
    if (!isPlainObject(value.destination) || !AI_PROVIDERS.includes(value.destination.provider)
      || !validateAiModel(value.destination.model)) throw new AiHostError('invalid-request', 'Invalid AI destination.');
    const configGeneration = value.destination.configGeneration;
    if (typeof configGeneration !== 'string' || !/^[a-f0-9-]{36}:\d+$/.test(configGeneration)) {
      throw new AiHostError('invalid-request', 'Invalid AI configuration generation.');
    }
    destination = { provider: value.destination.provider, model: value.destination.model, configGeneration };
  }
  return {
    requestId: value.requestId,
    followUp,
    envelopeJson: value.envelopeJson,
    envelopeBytes: refineBytes,
    ...(destination ? { destination } : {}),
    binding: draftBinding(value.binding, originalContext.targets),
  };
}

// ---- Draft plan validation: the host-side mirror of parseAiDraftResponse
// in src/ai/draft-plan.ts. The two implementations pin the same contract
// (docs/AI-ASSISTANT-M3.md); a plan that fails either side is refused whole
// with kind 'invalid-plan' and nothing is ever repaired or partially kept.

const DRAFT_TOP_KEYS = new Set(['outcome', 'message', 'operations']);
const DRAFT_OP_KEYS = new Set([
  'op', 'a', 'b', 'center', 'radius', 'origin', 'width', 'height', 'rotationDeg',
  'layer', 'targetIds', 'dx', 'dy', 'pivot', 'angleDeg',
]);
const DRAFT_ID_MAX_CHARS = 512;
/** Fields that must be null for each op (non-null = misplaced data). */
const DRAFT_NULL_FIELDS = Object.freeze({
  createLine: ['center', 'radius', 'origin', 'width', 'height', 'rotationDeg', 'targetIds', 'dx', 'dy', 'pivot', 'angleDeg'],
  createCircle: ['a', 'b', 'origin', 'width', 'height', 'rotationDeg', 'targetIds', 'dx', 'dy', 'pivot', 'angleDeg'],
  createRectangle: ['a', 'b', 'center', 'radius', 'targetIds', 'dx', 'dy', 'pivot', 'angleDeg'],
  move: ['a', 'b', 'center', 'radius', 'origin', 'width', 'height', 'rotationDeg', 'layer', 'pivot', 'angleDeg'],
  copy: ['a', 'b', 'center', 'radius', 'origin', 'width', 'height', 'rotationDeg', 'layer', 'pivot', 'angleDeg'],
  rotate: ['a', 'b', 'center', 'radius', 'origin', 'width', 'height', 'rotationDeg', 'layer', 'dx', 'dy'],
  delete: ['a', 'b', 'center', 'radius', 'origin', 'width', 'height', 'rotationDeg', 'layer', 'dx', 'dy', 'pivot', 'angleDeg'],
});

function invalidPlan(message) {
  return new AiHostError('invalid-plan', message);
}

function draftPoint(value) {
  if (!isPlainObject(value)) return null;
  if (Object.keys(value).length !== 2 || typeof value.x !== 'number' || typeof value.y !== 'number') return null;
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
  if (Math.abs(value.x) > AI_LIMITS.maxDraftCoordinate || Math.abs(value.y) > AI_LIMITS.maxDraftCoordinate) return null;
  return { x: value.x, y: value.y };
}

function draftDimension(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value <= 0 || value > AI_LIMITS.maxDraftDimension) return null;
  return value;
}

function draftFinite(value, maxAbs) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > maxAbs) return null;
  return value;
}

/** @returns {string | null | undefined} the layer, null for absent, undefined for invalid */
function draftLayer(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > DRAFT_ID_MAX_CHARS) return undefined;
  return value;
}

function draftTargets(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > AI_LIMITS.maxDraftTargetsPerOp) return null;
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== 'string' || id.length === 0 || id.length > DRAFT_ID_MAX_CHARS) return null;
    if (seen.has(id)) return null;
    seen.add(id);
  }
  return [...value];
}

/** Normalize one raw operation to the plan shape, or return null. */
function draftOperation(raw) {
  if (!isPlainObject(raw)) return null;
  for (const key of Object.keys(raw)) if (!DRAFT_OP_KEYS.has(key)) return null;
  const op = raw.op;
  if (typeof op !== 'string' || !Object.hasOwn(DRAFT_NULL_FIELDS, op)) return null;
  for (const field of DRAFT_NULL_FIELDS[op]) if (raw[field] !== null && raw[field] !== undefined) return null;
  switch (op) {
    case 'createLine': {
      const a = draftPoint(raw.a), b = draftPoint(raw.b), layer = draftLayer(raw.layer);
      if (!a || !b || layer === undefined) return null;
      if (a.x === b.x && a.y === b.y) return null; // zero-length line
      return { op, a, b, layer };
    }
    case 'createCircle': {
      const center = draftPoint(raw.center), radius = draftDimension(raw.radius), layer = draftLayer(raw.layer);
      if (!center || radius === null || layer === undefined) return null;
      return { op, center, radius, layer };
    }
    case 'createRectangle': {
      const origin = draftPoint(raw.origin), width = draftDimension(raw.width), height = draftDimension(raw.height);
      let rotationDeg = null;
      if (raw.rotationDeg !== null && raw.rotationDeg !== undefined) {
        rotationDeg = draftFinite(raw.rotationDeg, 3600);
        if (rotationDeg === null) return null;
      }
      const layer = draftLayer(raw.layer);
      if (!origin || width === null || height === null || layer === undefined) return null;
      return { op, origin, width, height, rotationDeg, layer };
    }
    case 'move':
    case 'copy': {
      const targetIds = draftTargets(raw.targetIds);
      const dx = draftFinite(raw.dx, AI_LIMITS.maxDraftCoordinate), dy = draftFinite(raw.dy, AI_LIMITS.maxDraftCoordinate);
      if (!targetIds || dx === null || dy === null) return null;
      if (dx === 0 && dy === 0) return null; // a no-op edit can never be staged
      return { op, targetIds, dx, dy };
    }
    case 'rotate': {
      const targetIds = draftTargets(raw.targetIds), pivot = draftPoint(raw.pivot);
      const angleDeg = draftFinite(raw.angleDeg, 3600);
      if (!targetIds || !pivot || angleDeg === null) return null;
      if (((angleDeg % 360) + 360) % 360 === 0) return null; // no-op rotation
      return { op, targetIds, pivot, angleDeg };
    }
    case 'delete': {
      const targetIds = draftTargets(raw.targetIds);
      if (!targetIds) return null;
      return { op, targetIds };
    }
    default:
      return null;
  }
}

/**
 * Validate a provider's raw draft response value (the mirror of
 * parseAiDraftResponse). Returns the normalized AiDraftResponse shape:
 * { kind: 'plan', plan } | { kind: 'clarification' | 'unsupported', message }.
 */
function parseDraftResponse(value) {
  if (!isPlainObject(value)) throw invalidPlan('The provider response was not an object.');
  for (const key of Object.keys(value)) if (!DRAFT_TOP_KEYS.has(key)) throw invalidPlan('The provider response carried unexpected fields.');
  const outcome = value.outcome;
  if (outcome !== 'proposal' && outcome !== 'clarification' && outcome !== 'unsupported') {
    throw invalidPlan('The provider response had an unknown outcome.');
  }
  const message = value.message;
  if (message !== null && message !== undefined
    && (typeof message !== 'string' || message.length > AI_LIMITS.maxDraftMessageChars)) {
    throw invalidPlan('The provider message was invalid.');
  }
  if (outcome !== 'proposal') {
    if (value.operations !== null && value.operations !== undefined) {
      throw invalidPlan('A clarification or unsupported response must not carry operations.');
    }
    if (typeof message !== 'string' || message.length === 0) {
      throw invalidPlan('The provider response did not explain itself.');
    }
    return { kind: outcome, message };
  }
  if (!Array.isArray(value.operations) || value.operations.length === 0) {
    throw invalidPlan('The proposal carried no operations.');
  }
  if (value.operations.length > AI_LIMITS.maxDraftOperations) {
    throw invalidPlan('The proposal carried too many operations.');
  }
  const operations = [];
  const targeted = new Set();
  let affected = 0, created = 0;
  for (const rawOp of value.operations) {
    const op = draftOperation(rawOp);
    if (!op) throw invalidPlan('The proposal contained an invalid or unsupported operation.');
    const targetIds = /** @type {{ targetIds?: string[] }} */ (op).targetIds;
    if (targetIds !== undefined) {
      affected += targetIds.length;
      if (op.op === 'copy') created += targetIds.length;
      for (const id of targetIds) {
        if (targeted.has(id)) throw invalidPlan('The proposal targeted the same object in more than one operation.');
        targeted.add(id);
      }
    } else {
      created += 1;
    }
    operations.push(op);
  }
  if (affected > AI_LIMITS.maxDraftAffected) throw invalidPlan('The proposal affected too many objects.');
  if (created > AI_LIMITS.maxDraftCreated) throw invalidPlan('The proposal created too many objects.');
  return {
    kind: 'plan',
    plan: { message: typeof message === 'string' && message.length > 0 ? message : null, operations },
  };
}

/**
 * Validate a transport draft result ({ value, contentBytes, usage }) before
 * the plan is allowed back to the renderer. The plan byte cap is enforced
 * from the adapter-reported raw content byte count before the value is
 * inspected; the value itself must satisfy the plan contract.
 */
function aiDraftResult(value) {
  if (!isPlainObject(value)) throw invalidPlan('The provider returned an invalid draft.');
  const contentBytes = value.contentBytes;
  if (!Number.isSafeInteger(contentBytes) || contentBytes < 0) {
    throw invalidPlan('The provider returned an invalid draft.');
  }
  let measuredBytes;
  try { measuredBytes = Buffer.byteLength(JSON.stringify(value.value), 'utf8'); }
  catch { throw invalidPlan('The provider returned an invalid draft.'); }
  if (contentBytes > AI_LIMITS.maxDraftPlanBytes || measuredBytes > AI_LIMITS.maxDraftPlanBytes) {
    throw invalidPlan('The draft plan exceeds the size limit.');
  }
  const response = parseDraftResponse(value.value);
  const result = { response, contentBytes: Math.max(contentBytes, measuredBytes) };
  // Provider-reported token usage rides along only as bounded counts.
  if (isPlainObject(value.usage)) {
    const providerUsage = {};
    for (const field of ['inputTokens', 'outputTokens']) {
      const tokens = value.usage[field];
      if (Number.isSafeInteger(tokens) && tokens >= 0) providerUsage[field] = tokens;
    }
    if (Object.keys(providerUsage).length > 0) result.providerUsage = providerUsage;
  }
  return result;
}

/** Per-job deadline for draft jobs, from enqueue (same value as the ask deadline default). */
const AI_DRAFT_TIMEOUT_MS = 30000;

/**
 * Create the host service. `transport` is the only provider-specific piece:
 * an async function (validatedRequest, signal) => answer, supplied when a
 * provider is agreed. The transport must abort network/body reads when its
 * signal aborts, and cap provider tokens/body bytes before reading an answer:
 * the usage counters below are not a spend limit. Without one, every ask refuses with
 * 'provider-not-configured' and nothing leaves the machine.
 * `draftTransport` (milestone 3) is the same contract for drafts:
 * (validatedDraftRequest, signal) => { value, contentBytes, usage }, run
 * through the same queue, concurrency and cancellation machinery with its
 * own per-job deadline (draftTimeoutMs). `refineTransport` (milestone 4)
 * is the same contract again for preview refinements and shares the
 * draft deadline.
 * @param {{ transport?: (request: object, signal: AbortSignal) => Promise<object>,
 *           draftTransport?: (request: object, signal: AbortSignal) => Promise<object>,
 *           refineTransport?: (request: object, signal: AbortSignal) => Promise<object>,
 *           timeoutMs?: number, draftTimeoutMs?: number,
 *           maxConcurrent?: number, maxPending?: number }} [options]
 */
function createAiHost({ transport, draftTransport, refineTransport, timeoutMs = 30000, draftTimeoutMs = AI_DRAFT_TIMEOUT_MS, maxConcurrent = 2, maxPending = 8 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647
    || !Number.isSafeInteger(draftTimeoutMs) || draftTimeoutMs < 1 || draftTimeoutMs > 2147483647
    || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1
    || !Number.isSafeInteger(maxPending) || maxPending < 0) {
    throw new AiHostError('invalid-request', 'Invalid AI host limits.');
  }
  let active = 0;
  let disposed = false;
  const queue = [];
  const jobs = new Map();
  const usage = {
    requests: 0, failures: 0, timeouts: 0, cancelled: 0,
    inputBytes: 0, outputChars: 0, lastDurationMs: 0,
  };

  function finish(job, error, value, outputChars = 0) {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.onAbort);
    jobs.delete(job.request.requestId);
    const queuedAt = queue.indexOf(job);
    if (queuedAt !== -1) queue.splice(queuedAt, 1);
    if (error) {
      if (error.kind === 'timeout') usage.timeouts += 1;
      else if (error.kind === 'cancelled') usage.cancelled += 1;
      else usage.failures += 1;
      job.reject(error);
    } else {
      usage.outputChars += outputChars;
      usage.lastDurationMs = Date.now() - job.started;
      job.resolve(value);
    }
  }

  function cancel(job, kind = 'cancelled') {
    if (job.settled) return;
    // Settle before aborting: a transport that resolves on abort cannot win.
    finish(job, new AiHostError(kind, kind === 'timeout'
      ? `The provider did not answer within ${job.limitMs} ms.` : 'The AI request was cancelled.'));
    job.controller.abort();
  }

  function pump() {
    while (!disposed && active < maxConcurrent && queue.length > 0) {
      const job = queue.shift();
      active += 1;
      run(job).finally(() => { active -= 1; pump(); });
    }
  }

  async function run(job) {
    try {
      if (job.settled) return;
      // ask()/draft() admit jobs only after confirming their transport is configured.
      if (job.kind === 'draft' || job.kind === 'refine') {
        const invoke = /** @type {NonNullable<typeof draftTransport>} */ (
          job.kind === 'refine' ? refineTransport : draftTransport);
        const raw = await invoke(job.request, job.controller.signal);
        if (!job.settled) {
          // aiDraftResult validates the plan (invalid → 'invalid-plan');
          // the raw provider value itself crosses back so the renderer's
          // parseAiDraftResponse stays the authoritative parse, exactly as
          // the ask path re-validates host answers renderer-side.
          const result = aiDraftResult(raw);
          finish(job, null, {
            value: /** @type {{ value: unknown }} */ (raw).value,
            usage: {
              inputBytes: job.kind === 'refine' ? job.request.envelopeBytes : job.request.contextBytes,
              outputChars: result.contentBytes, durationMs: Date.now() - job.started,
            },
            ...(result.providerUsage ? { providerUsage: result.providerUsage } : {}),
          }, result.contentBytes);
        }
      } else {
        const invoke = /** @type {NonNullable<typeof transport>} */ (transport);
        const raw = await invoke(job.request, job.controller.signal);
        if (!job.settled) {
          const answer = aiAnswer(raw);
          finish(job, null, {
            ...answer,
            usage: { inputBytes: job.request.snapshotBytes, outputChars: answer.text.length, durationMs: Date.now() - job.started },
          }, answer.text.length);
        }
      }
    } catch (cause) {
      finish(job, cause instanceof AiHostError
        ? cause
        : new AiHostError('provider-failure', 'The AI provider request failed.'));
    }
    // The concurrency slot is released only when the underlying transport
    // settles, including after cancellation. Ignoring abort cannot multiply
    // live transports; queued requests still expire on their own timers.
  }

  function enqueue(kind, request, signal, limitMs) {
    return new Promise((resolve, reject) => {
      const job = { kind, request, resolve, reject, signal, controller: new AbortController(),
        settled: false, started: Date.now(), limitMs,
        timer: /** @type {ReturnType<typeof setTimeout> | null} */ (null),
        onAbort: /** @type {(() => void) | null} */ (null) };
      job.onAbort = () => cancel(job);
      jobs.set(request.requestId, job);
      signal?.addEventListener('abort', job.onAbort, { once: true });
      if (signal?.aborted) { cancel(job); return; }
      job.timer = setTimeout(() => cancel(job, 'timeout'), limitMs);
      queue.push(job);
      pump();
    });
  }

  function requireSignal(signal) {
    if (signal && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function'
      || typeof signal.removeEventListener !== 'function')) throw new AiHostError('invalid-request', 'Invalid cancellation signal.');
    if (signal?.aborted) throw new AiHostError('cancelled', 'The AI request was cancelled.');
  }

  return {
    // An injected same-process bridge passes its AbortSignal directly. The
    // IPC bridge (electron/main/ipc-ai.cjs) instead translates a renderer
    // abort into cancel(requestId) within the host instance scoped to that
    // guarded sender; signals are not serializable IPC values.
    async ask(value, signal) {
      if (disposed) throw new AiHostError('disposed', 'The AI host has been disposed.');
      requireSignal(signal);
      const request = aiRequest(value);
      usage.requests += 1;
      usage.inputBytes += request.snapshotBytes;
      if (typeof transport !== 'function') {
        throw new AiHostError('provider-not-configured', 'No live AI provider has been selected; the AI host is inactive.');
      }
      if (jobs.has(request.requestId)) throw new AiHostError('invalid-request', 'Duplicate AI request id.');
      if (active >= maxConcurrent && queue.length >= maxPending) {
        throw new AiHostError('provider-failure', 'Too many pending AI requests.');
      }
      return enqueue('ask', request, signal, timeoutMs);
    },
    /** Milestone 3: the draft twin of ask(), over the draft transport. */
    async draft(value, signal) {
      if (disposed) throw new AiHostError('disposed', 'The AI host has been disposed.');
      requireSignal(signal);
      const request = aiDraftRequest(value);
      usage.requests += 1;
      usage.inputBytes += request.contextBytes;
      if (typeof draftTransport !== 'function') {
        throw new AiHostError('provider-not-configured', 'No live AI provider has been selected; the AI host is inactive.');
      }
      if (jobs.has(request.requestId)) throw new AiHostError('invalid-request', 'Duplicate AI request id.');
      if (active >= maxConcurrent && queue.length >= maxPending) {
        throw new AiHostError('provider-failure', 'Too many pending AI requests.');
      }
      return enqueue('draft', request, signal, draftTimeoutMs);
    },
    /** Milestone 4: the refinement twin of draft(), over the refine transport. */
    async refine(value, signal) {
      if (disposed) throw new AiHostError('disposed', 'The AI host has been disposed.');
      requireSignal(signal);
      const request = aiRefineRequest(value);
      usage.requests += 1;
      usage.inputBytes += request.envelopeBytes;
      if (typeof refineTransport !== 'function') {
        throw new AiHostError('provider-not-configured', 'No live AI provider has been selected; the AI host is inactive.');
      }
      if (jobs.has(request.requestId)) throw new AiHostError('invalid-request', 'Duplicate AI request id.');
      if (active >= maxConcurrent && queue.length >= maxPending) {
        throw new AiHostError('provider-failure', 'Too many pending AI requests.');
      }
      return enqueue('refine', request, signal, draftTimeoutMs);
    },
    cancel(requestId) {
      const job = jobs.get(requestId);
      if (!job) return false;
      cancel(job);
      return true;
    },
    /** Cancel every outstanding job (queued and running); returns how many. */
    cancelAll() {
      const outstanding = [...jobs.values()];
      for (const job of outstanding) cancel(job);
      return outstanding.length;
    },
    usage: () => ({ ...usage }),
    async dispose() {
      disposed = true;
      for (const job of [...jobs.values()]) cancel(job);
    },
  };
}

const LINUX_KEYRING_BACKENDS = Object.freeze(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);
const AI_MAX_CIPHERTEXT_BYTES = 8192;

/** The one API-key shape rule, shared by the key store and the service. */
function validateApiKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > AI_LIMITS.maxKeyChars
    || /[\u0000-\u001f]/.test(key)) {
    throw new AiHostError('invalid-request', 'Invalid API key.');
  }
  return key;
}

/**
 * API-key store backed by Electron safeStorage (OS-backed encryption:
 * DPAPI / Keychain / libsecret). Stores only ciphertext at `filePath`
 * (a fixed application-data path; registration supplies it). Since
 * milestone 2 the store is wired by electron/main/ipc-ai.cjs, which also
 * injects the fs seams — production writes/deletes go through the app's
 * atomic writer (electron/atomic-write.cjs), so a failed save never
 * destroys the previously stored key. The `fsImpl`-derived defaults keep
 * the milestone-1 behaviour for callers that inject nothing new.
 * The key is host-internal: readKey() exists for the service's transport
 * factory and must never be exposed over IPC. If OS encryption is
 * unavailable the store refuses to persist anything — plaintext fallback
 * is refused, always.
 * @param {{ safeStorage: { isEncryptionAvailable: () => boolean,
 *                          getSelectedStorageBackend?: () => string,
 *                          encryptString: (plain: string) => Buffer,
 *                          decryptString: (cipher: Buffer) => string },
 *           filePath: string, fsImpl?: typeof fs, platform?: string,
 *           writeFileAtomic?: (filePath: string, data: Buffer) => Promise<void>,
 *           readFile?: (filePath: string) => Buffer,
 *           removeFile?: (filePath: string) => Promise<void> | void,
 *           fileExists?: (filePath: string) => boolean }} options
 */
function createAiKeyStore({ safeStorage, filePath, fsImpl = fs, platform = process.platform,
  writeFileAtomic, readFile, removeFile, fileExists }) {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function'
    || typeof safeStorage.encryptString !== 'function' || typeof safeStorage.decryptString !== 'function') {
    throw new AiHostError('host-unavailable', 'safeStorage is required for the AI key store.');
  }
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new AiHostError('host-unavailable', 'The AI key store needs an absolute file path.');
  }
  const writeAtomic = writeFileAtomic ?? (async (target, data) => {
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
    fsImpl.writeFileSync(target, data, { mode: 0o600 });
  });
  const read = readFile ?? ((target) => fsImpl.readFileSync(target));
  const remove = removeFile ?? ((target) => { fsImpl.unlinkSync(target); });
  const exists = fileExists ?? ((target) => fsImpl.existsSync(target));
  function osEncryptionAvailable() {
    try {
      const backend = platform === 'linux' ? safeStorage.getSelectedStorageBackend?.() : null;
      return !!safeStorage.isEncryptionAvailable() && (platform !== 'linux'
        || (typeof backend === 'string' && LINUX_KEYRING_BACKENDS.includes(backend)));
    } catch {
      return false;
    }
  }
  function requireOsEncryption() {
    if (!osEncryptionAvailable()) {
      throw new AiHostError('host-unavailable', 'OS-backed encryption is unavailable; refusing to store or read the API key.');
    }
  }
  function readCiphertext() {
    const ciphertext = read(filePath);
    if (!Buffer.isBuffer(ciphertext) || ciphertext.length > AI_MAX_CIPHERTEXT_BYTES) {
      throw new AiHostError('credential-corrupt', 'The stored API key exceeds the permitted size. Forget the key and save it again.');
    }
    return ciphertext;
  }
  return {
    /** Whether OS-backed encryption can be used at all; never throws. */
    encryptionAvailable() {
      return osEncryptionAvailable();
    },
    hasKey() {
      return exists(filePath);
    },
    async saveKey(key) {
      validateApiKey(key);
      requireOsEncryption();
      let ciphertext;
      try {
        ciphertext = safeStorage.encryptString(key);
        await writeAtomic(filePath, ciphertext);
      } catch {
        throw new AiHostError('credential-unavailable', 'The API key could not be stored securely.');
      }
    },
    readKey() {
      if (!exists(filePath)) return null;
      requireOsEncryption();
      const ciphertext = readCiphertext();
      try {
        return validateApiKey(safeStorage.decryptString(ciphertext));
      } catch {
        throw new AiHostError('credential-corrupt', 'The stored API key could not be decrypted. It may be corrupt or from another machine/user. Forget the key and save it again.');
      }
    },
    async clearKey() {
      if (!exists(filePath)) return;
      try {
        await remove(filePath);
      } catch {
        throw new AiHostError('credential-delete-failed', 'The stored API key could not be deleted.');
      }
    },
    /** Change ciphertext and configuration as one recoverable host operation. */
    async changeKey(key, commit) {
      const previous = exists(filePath) ? readCiphertext() : null;
      if (key !== null) {
        validateApiKey(key);
        requireOsEncryption();
      }
      try {
        if (key === null) { if (previous !== null) await remove(filePath); }
        else await writeAtomic(filePath, safeStorage.encryptString(key));
      } catch {
        throw new AiHostError(key === null ? 'credential-delete-failed' : 'credential-unavailable', 'The API key could not be updated securely.');
      }
      try { await commit(); } catch (cause) {
        try {
          if (previous !== null) await writeAtomic(filePath, previous);
          else if (exists(filePath)) await remove(filePath);
        } catch {
          throw new AiHostError('credential-rollback-failed', 'The API key update could not be restored. Live requests are blocked until the key is saved or forgotten.');
        }
        throw cause;
      }
    },
  };
}

const AI_PROVIDERS = Object.freeze(['openai', 'anthropic']);
const AI_DEFAULT_MODEL = 'gpt-5';
const AI_PROVIDER_DEFAULT_MODELS = Object.freeze({ openai: 'gpt-5', anthropic: 'claude-sonnet-5-5' });
const AI_KEY_PERSISTENCE_MODES = Object.freeze(['session', 'encrypted']);
/** Config JSON is tiny by construction; anything larger on disk is invalid. */
const AI_MAX_CONFIG_BYTES = 4 * 1024;

/** @typedef {'openai' | 'anthropic'} AiProviderId */
/** @typedef {{ model: string, enabled: boolean, keyPersistence: string }} AiProviderEntry */
/** @typedef {{ version: 2, provider: AiProviderId,
 *             providers: { openai: AiProviderEntry, anthropic: AiProviderEntry } }} AiConfig */

/** A model id is a bounded provider token, never a path or URL fragment. */
function validateAiModel(model) {
  return typeof model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model);
}

/** @returns {AiConfig} */
function defaultAiConfig() {
  /** @type {AiConfig} */
  const config = {
    version: 2,
    provider: 'openai',
    providers: {
      openai: { model: AI_PROVIDER_DEFAULT_MODELS.openai, enabled: false, keyPersistence: 'session' },
      anthropic: { model: AI_PROVIDER_DEFAULT_MODELS.anthropic, enabled: false, keyPersistence: 'session' },
    },
  };
  return config;
}

/** Deep copy: config values are plain JSON data by construction. */
function cloneAiConfig(config) {
  return /** @type {AiConfig} */ (JSON.parse(JSON.stringify(config)));
}

/**
 * Validate one provider entry field by field: an invalid model falls back
 * to that provider's default, `enabled` counts only when strictly `true`,
 * and an unknown persistence mode falls back to 'session'. A missing or
 * non-object entry yields the provider defaults.
 * @param {AiProviderId} provider
 * @param {any} value
 * @returns {AiProviderEntry | null}
 */
function parseProviderEntry(provider, value) {
  if (!isPlainObject(value) || !validateAiModel(value.model) || typeof value.enabled !== 'boolean'
    || !AI_KEY_PERSISTENCE_MODES.includes(value.keyPersistence)) return null;
  const source = value;
  return {
    model: validateAiModel(source.model)
      ? /** @type {string} */ (source.model)
      : AI_PROVIDER_DEFAULT_MODELS[provider],
    enabled: source.enabled === true,
    keyPersistence: AI_KEY_PERSISTENCE_MODES.includes(/** @type {string} */ (source.keyPersistence))
      ? /** @type {string} */ (source.keyPersistence)
      : 'session',
  };
}

/**
 * Validate a parsed config value; returns a clean v2 copy or null. A v1
 * config (the short-lived single-provider shape: top-level
 * model/enabled/keyPersistence) migrates silently — its values become the
 * OpenAI entry and Anthropic starts from defaults.
 * @param {any} value
 * @returns {AiConfig | null}
 */
function parseAiConfig(value) {
  if (!isPlainObject(value)) return null;
  if (value.version === 2) {
    if (!isPlainObject(value.providers) || !AI_PROVIDERS.includes(value.provider)) return null;
    const openai = parseProviderEntry('openai', value.providers.openai);
    const anthropic = parseProviderEntry('anthropic', value.providers.anthropic);
    if (!openai || !anthropic) return null;
    return {
      version: 2,
      provider: AI_PROVIDERS.includes(/** @type {AiProviderId} */ (value.provider))
        ? /** @type {AiProviderId} */ (value.provider)
        : 'openai',
      providers: {
        openai,
        anthropic,
      },
    };
  }
  if (value.version === 1) {
    const openai = parseProviderEntry('openai', value);
    if (value.provider !== 'openai' || !openai) return null;
    return {
      version: 2,
      provider: 'openai',
      providers: {
        openai,
        anthropic: defaultAiConfig().providers.anthropic,
      },
    };
  }
  return null;
}

/**
 * Host-authoritative AI connection settings (selected provider plus a
 * per-provider model/enabled/key-persistence entry — never a key),
 * persisted as bounded v2 JSON at a fixed application-data path through
 * injected fs seams. A missing file is the defaults; an unreadable or
 * invalid file falls back to the defaults with a `problem` code
 * ('config-unreadable' / 'config-invalid') so the UI can say so instead
 * of silently misbehaving. A v1 file migrates on load (parseAiConfig).
 * @param {{ filePath: string,
 *           writeFileAtomic: (filePath: string, data: Buffer) => Promise<void>,
 *           readFile: (filePath: string) => Buffer,
 *           fileExists: (filePath: string) => boolean }} options
 */
function createAiConfigStore({ filePath, writeFileAtomic, readFile, fileExists }) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)
    || typeof writeFileAtomic !== 'function' || typeof readFile !== 'function'
    || typeof fileExists !== 'function') {
    throw new AiHostError('host-unavailable', 'The AI config store needs an absolute file path and fs seams.');
  }
  /** @type {AiConfig | null} */
  let cache = null;
  const store = {
    /** Load (or reload) from disk; caches and reports any problem. */
    async load() {
      let problem = null;
      /** @type {AiConfig} */
      let config = defaultAiConfig();
      if (fileExists(filePath)) {
        let raw = null;
        try {
          raw = readFile(filePath);
        } catch {
          problem = 'config-unreadable';
        }
        if (raw !== null) {
          const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          if (buffer.length >= AI_MAX_CONFIG_BYTES) {
            problem = 'config-invalid';
          } else {
            let parsed;
            try {
              parsed = JSON.parse(buffer.toString('utf8'));
            } catch {
              problem = 'config-unreadable';
            }
            if (problem === null) {
              const valid = parseAiConfig(parsed);
              if (valid) config = valid;
              else problem = 'config-invalid';
            }
          }
        }
      }
      cache = config;
      return { config: cloneAiConfig(config), problem };
    },
    /** The cached config as a deep copy (defaults until load() has run). */
    get() {
      return cloneAiConfig(cache ?? defaultAiConfig());
    },
    /**
     * Merge a validated patch (unknown keys ignored) and persist it.
     * `provider` applies first; model/enabled/keyPersistence then apply
     * to the entry of the provider selected after the patch. The cache
     * changes only after the write succeeds.
     */
    async update(patch) {
      if (!isPlainObject(patch)) throw new AiHostError('invalid-request', 'Invalid AI settings.');
      const next = cloneAiConfig(cache ?? defaultAiConfig());
      if (Object.hasOwn(patch, 'provider')) {
        if (!AI_PROVIDERS.includes(/** @type {AiProviderId} */ (patch.provider))) {
          throw new AiHostError('invalid-request', 'Invalid AI provider.');
        }
        next.provider = /** @type {AiProviderId} */ (patch.provider);
      }
      const entry = next.providers[next.provider];
      if (Object.hasOwn(patch, 'model')) {
        if (!validateAiModel(patch.model)) throw new AiHostError('invalid-request', 'Invalid AI model.');
        entry.model = /** @type {string} */ (patch.model);
      }
      if (Object.hasOwn(patch, 'enabled')) {
        if (typeof patch.enabled !== 'boolean') throw new AiHostError('invalid-request', 'Invalid AI enabled flag.');
        entry.enabled = patch.enabled;
      }
      if (Object.hasOwn(patch, 'keyPersistence')) {
        if (!AI_KEY_PERSISTENCE_MODES.includes(/** @type {string} */ (patch.keyPersistence))) {
          throw new AiHostError('invalid-request', 'Invalid AI key persistence mode.');
        }
        entry.keyPersistence = /** @type {string} */ (patch.keyPersistence);
      }
      try {
        await writeFileAtomic(filePath, Buffer.from(JSON.stringify(next), 'utf8'));
      } catch {
        throw new AiHostError('credential-unavailable', 'The AI settings could not be saved.');
      }
      cache = next;
      return cloneAiConfig(next);
    },
  };
  // Atomic writes alone do not prevent overlapping patches from overwriting
  // one another. Merge each patch only after earlier writes have settled.
  let operationTail = Promise.resolve();
  /** @template T @param {() => Promise<T> | T} work @returns {Promise<T>} */
  const serialize = (work) => {
    const result = operationTail.then(work);
    operationTail = result.then(() => {}, () => {});
    return result;
  };
  return { ...store, load: () => serialize(() => store.load()), update: (patch) => serialize(() => store.update(patch)) };
}

const AI_PROBE_TIMEOUT_MS = 15000;

/**
 * A provider transport: answers a validated request, and may carry a
 * `probe` for the connection test, a `draft` for milestone-3 plan
 * requests and a `refineDraft` for milestone-4 preview refinements
 * ((validatedRequest, signal) => { value, contentBytes, usage }).
 * @typedef {((request: object, signal: AbortSignal) => Promise<object>)
 *   & { probe?: (signal: AbortSignal) => Promise<object>,
 *       draft?: (request: object, signal: AbortSignal) => Promise<object>,
 *       refineDraft?: (request: object, signal: AbortSignal) => Promise<object> }} AiTransportFn
 */

/** Whether a value quacks like a key store (service construction check). */
function isKeyStoreShape(value) {
  return !!value && typeof value.readKey === 'function' && typeof value.saveKey === 'function'
    && typeof value.clearKey === 'function' && typeof value.hasKey === 'function' && typeof value.changeKey === 'function';
}

/**
 * The live AI service: the single owner of connection state. It combines
 * the config store (authoritative selected provider + per-provider
 * entries), one key store per provider (encrypted persistence) plus a
 * per-provider in-memory session key, and a request host it constructs
 * internally with a dispatching transport — the real provider transport
 * is built lazily by `transportFactory` for the selected provider's
 * current model/key and rebuilt whenever that provider's model or key
 * changes. Keys, model/enabled settings and transports are strictly per
 * provider: a provider's key is only ever sent to that provider, and
 * there is no automatic fallback. Nothing here logs or returns key
 * material; cached keys live only in closures of this factory.
 * @param {{ host?: { timeoutMs?: number, draftTimeoutMs?: number, maxConcurrent?: number, maxPending?: number },
 *           configStore: ReturnType<typeof createAiConfigStore>,
 *           keyStores: { openai: ReturnType<typeof createAiKeyStore>,
 *                        anthropic: ReturnType<typeof createAiKeyStore> },
 *           transportFactory: (options: { provider: string, model: string, apiKey: string }) =>
 *             AiTransportFn }} options
 */
function createAiService({ host: hostOptions, configStore, keyStores, transportFactory }) {
  if (!configStore || typeof configStore.load !== 'function' || typeof configStore.get !== 'function'
    || typeof configStore.update !== 'function'
    || !keyStores || !isKeyStoreShape(keyStores.openai) || !isKeyStoreShape(keyStores.anthropic)
    || typeof transportFactory !== 'function') {
    throw new AiHostError('host-unavailable', 'The AI service needs a config store, per-provider key stores and a transport factory.');
  }
  /** @type {Record<AiProviderId, string | null>} */
  const sessionKeys = { openai: null, anthropic: null };
  /** @type {Record<AiProviderId, { transport: AiTransportFn, model: string, key: string } | null>} */
  const transportCaches = { openai: null, anthropic: null };
  const blockedCredentials = { openai: false, anthropic: false };
  const probes = new Set();
  let probeTransports = 0;
  let disposed = false;
  let loaded = false;
  let pendingMutations = 0;
  let workGeneration = 0;
  const serviceEpoch = randomUUID();
  const configGeneration = () => `${serviceEpoch}:${workGeneration}`;
  /** @type {Promise<void>} */
  let mutationTail = Promise.resolve();
  /** @type {string | null} */
  let configProblem = null;
  /** @type {Promise<void> | null} */
  let loadPromise = null;

  function requireOpen() {
    if (disposed) throw new AiHostError('disposed', 'The AI host has been disposed.');
  }
  function ensureLoaded() {
    if (!loadPromise) {
      loadPromise = Promise.resolve().then(() => configStore.load()).then(({ problem }) => {
        configProblem = problem;
        loaded = true;
      });
    }
    return loadPromise;
  }
  /** @returns {AiProviderId} */
  function selectedProvider() { return configStore.get().provider; }
  /** @param {AiProviderId} provider */
  function entryFor(provider) { return configStore.get().providers[provider]; }
  function requireKey(provider) {
    if (blockedCredentials[provider]) throw new AiHostError('credential-unavailable', 'Save or forget the API key before making another live request.');
    const stored = keyStores[provider].hasKey();
    if (sessionKeys[provider] === null && stored && entryFor(provider).keyPersistence !== 'encrypted') {
      throw new AiHostError('credential-unavailable', 'The stored API key is not enabled by the saved persistence setting. Forget it or save it again.');
    }
    const key = sessionKeys[provider] ?? (stored && entryFor(provider).keyPersistence === 'encrypted' ? keyStores[provider].readKey() : null);
    if (key === null) throw new AiHostError('provider-not-configured', 'No API key is saved for Live AI. Save a key in the AI panel connection settings.');
    return validateApiKey(key);
  }
  function transportFor(provider, model, key) {
    const cached = transportCaches[provider];
    if (cached && cached.model === model && cached.key === key) return cached.transport;
    const transport = transportFactory({ provider, model, apiKey: key });
    if (typeof transport !== 'function') throw new AiHostError('provider-not-configured', 'The selected provider is not available.');
    transportCaches[provider] = { transport, model, key };
    return transport;
  }
  function requireStable(generation) {
    requireOpen();
    if (pendingMutations !== 0 || generation !== workGeneration) {
      throw new AiHostError('cancelled', 'The AI configuration or renderer changed. Review the connection settings and ask again.');
    }
  }
  function requireDestination(value, draft = false) {
    const provider = selectedProvider(), model = entryFor(provider).model;
    if (!isPlainObject(value) || !isPlainObject(value.destination)
      || value.destination.provider !== provider || value.destination.model !== model
      || (draft && value.destination.configGeneration !== configGeneration())) {
      throw new AiHostError('cancelled', 'The selected AI provider or model changed. Review the connection settings and ask again.');
    }
    return { provider, model };
  }
  const innerHost = createAiHost({
    ...(isPlainObject(hostOptions) ? hostOptions : {}),
    transport: async (request, signal) => {
      requireStable(workGeneration);
      const { provider, model } = requireDestination(request);
      if (!entryFor(provider).enabled || signal.aborted) throw new AiHostError('cancelled', 'The AI request was cancelled.');
      return transportFor(provider, model, requireKey(provider))(request, signal);
    },
    draftTransport: async (request, signal) => {
      requireStable(workGeneration);
      const { provider, model } = requireDestination(request, true);
      if (!entryFor(provider).enabled || signal.aborted) throw new AiHostError('cancelled', 'The AI request was cancelled.');
      const transport = transportFor(provider, model, requireKey(provider));
      if (typeof transport.draft !== 'function') {
        throw new AiHostError('provider-not-configured', 'The selected provider cannot draft. Update the application and try again.');
      }
      return transport.draft(request, signal);
    },
    refineTransport: async (request, signal) => {
      requireStable(workGeneration);
      const { provider, model } = requireDestination(request, true);
      if (!entryFor(provider).enabled || signal.aborted) throw new AiHostError('cancelled', 'The AI request was cancelled.');
      const transport = transportFor(provider, model, requireKey(provider));
      if (typeof transport.refineDraft !== 'function') {
        throw new AiHostError('provider-not-configured', 'The selected provider cannot refine previews. Update the application and try again.');
      }
      return transport.refineDraft(request, signal);
    },
  });
  function cancelAll() {
    workGeneration += 1; // Also revokes asks/probes still awaiting initial configuration load.
    for (const controller of probes) controller.abort();
    return innerHost.cancelAll();
  }
  function mutate(work) {
    requireOpen();
    if (pendingMutations >= 16) return Promise.reject(new AiHostError('provider-failure', 'Too many pending AI settings changes.'));
    pendingMutations += 1;
    cancelAll();
    const result = mutationTail.then(async () => {
      requireOpen();
      await ensureLoaded();
      requireOpen();
      await work();
      configProblem = null;
    });
    const settled = result.finally(() => { pendingMutations -= 1; });
    mutationTail = settled.then(() => {}, () => {});
    return settled;
  }
  async function changeKey(provider, key, persistence) {
    try {
      if (persistence === 'encrypted' && entryFor(provider).keyPersistence === 'encrypted') {
        // Same-mode replacement is one atomic ciphertext write. A second,
        // unrelated config write cannot turn its success into a partial failure.
        await keyStores[provider].saveKey(key);
      } else {
        await keyStores[provider].changeKey(persistence === 'encrypted' ? key : null,
          () => configStore.update({ keyPersistence: persistence }));
      }
    } catch (cause) {
      if (cause instanceof AiHostError && cause.kind === 'credential-rollback-failed') blockedCredentials[provider] = true;
      throw cause;
    }
    sessionKeys[provider] = persistence === 'session' ? key : null;
    transportCaches[provider] = null;
    blockedCredentials[provider] = false;
  }
  return {
    async getState() {
      requireOpen();
      await ensureLoaded();
      await mutationTail;
      requireOpen();
      const provider = selectedProvider(), entry = entryFor(provider), store = keyStores[provider];
      const session = sessionKeys[provider], stored = store.hasKey();
      let keyPresent = false, credentialProblem = null;
      if (session !== null || stored) {
        try { requireKey(provider); keyPresent = true; }
        catch (cause) { credentialProblem = cause instanceof AiHostError ? cause.kind : 'credential-unavailable'; }
      }
      return {
        provider, providers: [...AI_PROVIDERS], model: entry.model, enabled: entry.enabled,
        configGeneration: configGeneration(),
        keyPersistence: entry.keyPersistence, keyPresent, keyStored: stored, credentialProblem,
        keySource: keyPresent ? session !== null ? 'session' : 'stored' : null,
        encryptionAvailable: store.encryptionAvailable(), configProblem,
      };
    },
    async setProvider(provider) {
      if (!AI_PROVIDERS.includes(provider)) throw new AiHostError('invalid-request', 'Invalid AI provider.');
      requireOpen();
      if (loaded && pendingMutations === 0 && provider === selectedProvider()) return;
      return mutate(async () => { if (provider !== selectedProvider()) await configStore.update({ provider }); });
    },
    async setKey(key, persistence) {
      validateApiKey(key);
      if (!AI_KEY_PERSISTENCE_MODES.includes(persistence)) throw new AiHostError('invalid-request', 'Invalid AI key persistence mode.');
      return mutate(() => changeKey(selectedProvider(), key, persistence));
    },
    async replaceKey(key) {
      validateApiKey(key);
      return mutate(() => {
        const provider = selectedProvider();
        return changeKey(provider, key, entryFor(provider).keyPersistence);
      });
    },
    async forgetKey() {
      return mutate(async () => {
        const provider = selectedProvider(), store = keyStores[provider];
        // Keep the effective session key if ciphertext deletion fails.
        if (store.hasKey()) await store.clearKey();
        sessionKeys[provider] = null;
        transportCaches[provider] = null;
        blockedCredentials[provider] = false;
      });
    },
    async setModel(model) {
      if (!validateAiModel(model)) throw new AiHostError('invalid-request', 'Invalid AI model.');
      return mutate(async () => { await configStore.update({ model }); });
    },
    async setEnabled(enabled) {
      if (typeof enabled !== 'boolean') throw new AiHostError('invalid-request', 'Invalid AI enabled flag.');
      return mutate(async () => {
        if (enabled) requireKey(selectedProvider());
        await configStore.update({ enabled });
      });
    },
    async ask(value, signal) {
      const generation = workGeneration;
      requireStable(generation);
      await ensureLoaded();
      requireStable(generation);
      const provider = selectedProvider();
      if (!entryFor(provider).enabled) throw new AiHostError('live-disabled', 'Live AI is not enabled. Enable it in the AI panel connection settings.');
      requireKey(provider);
      requireDestination(value);
      const answer = await innerHost.ask(value, signal);
      requireStable(generation);
      return answer;
    },
    /** Milestone 3: the draft twin of ask(), with the same guards. */
    async draft(value, signal) {
      const generation = workGeneration;
      requireStable(generation);
      await ensureLoaded();
      requireStable(generation);
      const provider = selectedProvider();
      if (!entryFor(provider).enabled) throw new AiHostError('live-disabled', 'Live AI is not enabled. Enable it in the AI panel connection settings.');
      requireKey(provider);
      requireDestination(value, true);
      const result = await innerHost.draft(value, signal);
      requireStable(generation);
      return { ...result, configGeneration: configGeneration() };
    },
    /** Milestone 4: the refinement twin of draft(), with the same guards. */
    async refine(value, signal) {
      const generation = workGeneration;
      requireStable(generation);
      await ensureLoaded();
      requireStable(generation);
      const provider = selectedProvider();
      if (!entryFor(provider).enabled) throw new AiHostError('live-disabled', 'Live AI is not enabled. Enable it in the AI panel connection settings.');
      requireKey(provider);
      requireDestination(value, true);
      const result = await innerHost.refine(value, signal);
      requireStable(generation);
      return { ...result, configGeneration: configGeneration() };
    },
    cancel: (requestId) => innerHost.cancel(requestId),
    cancelAll,
    usage: () => innerHost.usage(),
    async testConnection(signal) {
      const generation = workGeneration;
      requireStable(generation);
      await ensureLoaded();
      requireStable(generation);
      if (signal?.aborted) throw new AiHostError('cancelled', 'The connection test was cancelled.');
      if (probeTransports !== 0) throw new AiHostError('provider-failure', 'An AI connection test is already running.');
      const provider = selectedProvider(), model = entryFor(provider).model;
      const transport = transportFor(provider, model, requireKey(provider)), probe = transport.probe;
      if (typeof probe !== 'function') throw new AiHostError('provider-not-configured', 'The selected provider cannot run a connection test.');
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      probes.add(controller);
      probeTransports += 1;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, AI_PROBE_TIMEOUT_MS);
      const abortRejection = new Promise((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new AiHostError(timedOut ? 'timeout' : 'cancelled',
          timedOut ? 'The connection test timed out.' : 'The connection test was cancelled.')), { once: true });
      });
      if (signal?.aborted) controller.abort();
      const invocation = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new AiHostError('cancelled', 'The connection test was cancelled.');
        return probe(controller.signal);
      });
      // A provider ignoring abort still occupies its slot until the real transport settles.
      invocation.then(() => { probeTransports -= 1; }, () => { probeTransports -= 1; });
      try {
        const raw = await Promise.race([invocation, abortRejection]);
        requireStable(generation);
        /** @type {{ model: string, outputLimited?: boolean, inputTokens?: number, outputTokens?: number }} */
        const result = { model };
        const usage = isPlainObject(raw) ? raw : {};
        if (usage.outputLimited === true) result.outputLimited = true;
        const counts = isPlainObject(usage.usage) ? usage.usage : usage;
        for (const field of ['inputTokens', 'outputTokens']) {
          const tokens = counts[field];
          if (Number.isSafeInteger(tokens) && tokens >= 0) result[field] = tokens;
        }
        return result;
      } catch (cause) {
        if (cause instanceof AiHostError) throw cause;
        throw new AiHostError('provider-failure', 'The AI connection test failed.');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        probes.delete(controller);
      }
    },
    async dispose() {
      disposed = true;
      cancelAll();
      await mutationTail;
      await innerHost.dispose();
      for (const provider of AI_PROVIDERS) { sessionKeys[provider] = null; transportCaches[provider] = null; }
    },
  };
}


module.exports = {
  AI_LIMITS, AiHostError, aiRequest, aiAnswer, aiDraftRequest, aiRefineRequest, aiDraftResult, createAiHost, createAiKeyStore,
  AI_PROVIDERS, AI_DEFAULT_MODEL, AI_PROVIDER_DEFAULT_MODELS, validateAiModel,
  createAiConfigStore, createAiService,
};
