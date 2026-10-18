// Electron/native xref refresh gate (P20.2, NATIVE-REFRESH-PLAN.md as
// approved with amendments 1-2; harness correction round G1/G3/G4).
// Drives the REAL app: the preload bridge (window.jcad beginXrefContext/
// identifyXref/readXref/cancelXref/closeXrefContext) -> main IPC -> broker
// -> the app's own path registry -> real files on disk and the real
// decoder. No registry/grant API is ever called by this harness.
//
// Registry seam (named, per G1): registry.isKnown is EXACT-PATH
// membership - opening one drawing makes only that path known. The app's
// designed route for a set of related drawings is its project file, so
// the generator emits xref-native.jcadproj.json listing every fixture
// drawing and this harness opens it through the genuine Open Project
// dialog flow (main then registers the listed drawings itself), before
// opening the host through the genuine OPEN flow. The harness grants
// nothing; all authority state is produced by the app's own flows.
//
// Loader seam (G1): the accepted loader and adapter sources
// (src/io/xref-loading.ts, src/app/xref-reader.ts) are bundled at run
// time with esbuild (plus a Vite `?raw` text plugin mirroring the app's
// own build semantics) and injected into the renderer, where the REAL
// XrefStore runs with the REAL adapter over window.jcad directly - so
// the adapter sees the genuine Electron invoke envelope, unchanged. The
// host's block table comes from the opened drawing itself
// (window.editor.doc.snapshot.blocks). Source and bundle hashes are
// recorded in the results header (G3).
//
// Runner recipe (bounded, per the lead brief): --work-root is REQUIRED
// and confines the fixture dir, the out dir, every Electron profile and
// TEMP/TMP. The Electron child env is constructed from a whitelist only
// (PATH, SystemRoot, windir, TEMP, TMP, ELECTRON_DISABLE_
// SECURITY_WARNINGS; DISPLAY/XAUTHORITY join the whitelist on non-win32
// only, where a headless X server is the launch mechanism). A 10-minute
// watchdog terminates ONLY this harness's own Electron processes.
// Nothing is deleted: profiles, outputs and fixtures stay as residue
// evidence and are recorded in results.json.
//
// G2 observer: broker-stats assertions and the in-flight quit witness
// evaluate only from samples of the pinned test-only observer
// (scripts/xref-test-observer.cjs, preloaded via the Electron CLI
// --require route under the G2 ruling) when this run is launched with
// --observer. Every launch captures its OWN observer baseline right
// after window-ready (per-instance coverage: baselines and one-instance
// proofs are never shared between app instances). Without a valid
// observer baseline/witness those criteria are BLOCKED (never passed
// by sleep) and make the exit code nonzero. Clean process exit is
// recorded as exit evidence only - it is NOT a completed-drain proof
// (the IPC dispose ignores the closeAll promise). Executing the
// observer is a separately admitted native step.
//
// Refresh oracle (correction round 2, finding 1): loader signatures
// serialize each external entity SEMANTICALLY - the canonical JSON of
// the entity with ONLY its top-level parser-generated `id` removed
// (commonProps in src/io/dxf/read-core.ts assigns id: newId() to every
// parsed entity; a re-parse of identical bytes always mints fresh ids,
// so raw serialization false-fails unchanged content). Everything else
// is compared in full: geometry, layer/appearance, retained properties
// and cadIdentity (the retained DXF group-5 handle). The comparator is
// defined once below and injected into the page verbatim from its own
// source; `node scripts/e2e-xref-refresh.mjs --self-test-oracle` runs
// its regression without Electron (same ids-different-bytes cases).
//
// Overlap oracle (finding 2; witness design v2, lead-approved
// PLAN-3.3-WITNESS): section 3.3 is orchestrated from Node in steps -
// a renewal chain of genuine full reads of the slow fixture runs on
// context A, and observer samples must show A busy (activeOps >= 1,
// reservedRawBytes = slow size + 1) at S1, at the same-context BUSY
// refusal (S2) AND after context B completes (S3), all on the one
// main clock/sequence. The chain replaced a single held read, which
// twice failed to span S1..S3 on the seat's PC (size cannot win: B's
// completion couples to A's transfer). The chain is a SEQUENCE, never
// concurrent - the broker admits ONE active op per context - and it
// stops deterministically (harness stop after S3, or a fixed link
// bound). The BUSY refusal is attempted a bounded number of times:
// an attempt admitted in an inter-link gap completes a real read and
// is logged. A sample that misses the chain's activity (inter-link
// gap, early chain end, unhealthy chain) makes the criterion BLOCKED
// (insufficient witness), never passed. Two accounting rules guard
// the stop/drain boundary (Codex rerun-3 review H1/H2): EVERY
// already-issued chain read is validated and accounted before the
// stop flag is honored - stop prevents the NEXT issuance, it never
// erases a pending outcome, so a late error or short read stays
// non-passing - and the witness accepts the chain only on a
// POSITIVELY confirmed drain (the done promise resolved with the
// final accounted state); a collection timeout, rejection or
// missing state leaves the summary undrained and BLOCKED, with any
// live counters kept as diagnostics only. The pass/blocked decision is
// one pure function (burstWitnessDecisionImpl below);
// `node scripts/e2e-xref-refresh.mjs --self-test-burst` runs its
// regression without Electron, including the fail-first old-shape
// trace (active, active, inactive at S3 -> BLOCKED).
//
// Same-broker correlation (correction round 3, group 2): a launch-zero
// baseline plus factoryCalls === 1 does NOT prove the observed broker
// is the one the real bridge drives. For EVERY launch, right after the
// bridge is installed, the harness performs a real bridge begin, then
// requires an observer sample at contexts = baseline+1 with NO active
// or reserved work (a begun context, before any read), then a real
// bridge close and a sample back at baseline contexts/tickets. Only a
// launch whose correlation holds may have its stats-derived checks
// evaluated; every other stats-derived check for that launch records
// BLOCKED ('same-broker correlation unproven for this launch'). The
// pass/blocked decision is one pure function (correlationDecisionImpl
// below); `node scripts/e2e-xref-refresh.mjs --self-test-correlation`
// runs its bookkeeping regression without Electron.
//
// Tab-removal precondition (section 3.5a): before the post-close
// read, the harness proves the host tab is actually gone - the host
// PATH and the host session's docId are both absent from the sessions
// list. The count expectation is shape-aware: closing one of several
// tabs drops the count by one, but closing the ONLY tab leaves the
// count at 1, because SessionManager.close (src/app/sessions.ts)
// replaces an emptied list with one fresh blank drawing (filePath
// null, fresh docId). The decision is one pure function
// (tabRemovalDecisionImpl below);
// `node scripts/e2e-xref-refresh.mjs --self-test-tab-removal` runs
// its regression without Electron.
//
//   npm run build
//   node scripts/xref-native-fixtures.mjs <work-root>/fixtures
//   node --experimental-strip-types scripts/e2e-xref-refresh.mjs \
//     --work-root <work-root> --fixtures <work-root>/fixtures \
//     --out <work-root>/out [--sections 3.1,3.2] \
//     [--head <candidate-head>] [--tree <candidate-tree>]
//   Stage 2 (packaged, admitted 2026-10-18): add
//     --packaged-exe <path to the unpacked test build's executable>
//   to target the packaged app (the `npm run dist:test` output) instead
//   of the development electron. Every check and verdict is unchanged.
//   node scripts/e2e-xref-refresh.mjs --self-test-oracle
//   node scripts/e2e-xref-refresh.mjs --self-test-correlation
//   node scripts/e2e-xref-refresh.mjs --self-test-tab-removal
//   node scripts/e2e-xref-refresh.mjs --self-test-burst
//
// Exit codes: 0 = every selected check passed and none blocked;
// 1 = a check failed or a selected criterion is blocked;
// 2 = invalid setup (fail closed, before any launch);
// 3 = evidence-persistence failure (results/log could not be written;
//     stdout and any partial files are the surviving record).
//
// Platform note: the broker validates Windows absolute paths by design
// (absoluteWindowsPath in electron/xref-read.cjs), and the preload
// exposes the xref bridge only on win32. On any other platform this
// harness validates its mechanics (confinement, fixture verification,
// bundle build, project/host open, headers) but the run stops at the
// bridge boundary - the gate itself is Windows-only, as designed.
//
// Architecture note (section 3.5): broker contexts are owned by the
// WebContents (electron/main/ipc-xrefs.cjs ownerOf hooks did-navigate
// and destroyed), AND the product additionally retires a document's
// contexts when its host tab closes, via an explicit renderer->main
// tab-close signal keyed by the session docId. Section 3.5a therefore
// begins its context with the host session's own docId, closes the
// tab, asserts the tab is actually gone, and applies the approved
// plan's tab-close criterion exactly as written; 3.5a2 is an
// ADDITIONAL observation of retirement on page navigation, not a
// substitute for 3.5a.
import { _electron as electron } from 'playwright';
import { applicationWindow } from './electron-window.mjs';
import { build as esbuildBuild } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : '';
};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const fileSha = (p) => sha256(readFileSync(p));
const MIB = 1024 * 1024;
const G2_REASON = 'observer not enabled for this run (no --observer): criterion stays BLOCKED under the G2 ruling';

// ------------------------------------------------------------ page-side + observer types
// The truthful shapes of what THIS harness installs on the page's
// window inside Playwright evaluate callbacks (the __xref bridge stub
// in installBridge, the injected __xrefCore bundle and semantic
// serializer, the G1 session slot, the per-section read slots) and of
// the Node-side per-launch observer state. scripts/types/
// page-globals.d.ts declares the app's own window members (editor,
// jcad); the members below are the harness's own, declared here with
// the signatures the harness actually installs and calls. Evaluate
// callbacks reach them through an XrefPageWindow cast of `window`.
// Bridge-stub result bags: every stub method resolves to
// { ok: true, ... } on success or { ok: false, code } on refusal, so
// the success-only fields are optional in the merged shape the
// sections consume (they gate on .ok via check() and read the fields
// directly).
/**
 * @typedef {Object} XrefFileIdentity - a broker file identity, as returned by the real bridge's identifyXref (FileBridge in src/app/editor/types.ts).
 * @property {string} id
 * @property {string} owningLocation
 * @property {string} version
 */
/**
 * @typedef {Object} XrefBeginResult - window.__xref.begin resolution.
 * @property {boolean} ok
 * @property {string} [token] - success only: the broker context token
 * @property {string} [code] - refusal only: an ERR_XREF_* code
 */
/**
 * @typedef {Object} XrefIdentifyResult - window.__xref.identify resolution.
 * @property {boolean} ok
 * @property {string} [ticket] - success only: the main-owned read ticket
 * @property {XrefFileIdentity} [identity] - success only
 * @property {string} [code] - refusal only: an ERR_XREF_* code
 */
/**
 * @typedef {Object} XrefReadResult - window.__xref.read resolution.
 * @property {boolean} ok
 * @property {number} [byteLength] - success only
 * @property {number} [rawBytes] - success only
 * @property {string} [rawSha256] - success only
 * @property {string} [version] - success only
 * @property {string} [text] - success only, and only for reads of at most 65536 raw bytes; otherwise the key is present with value undefined
 * @property {string} [code] - refusal only: an ERR_XREF_* code
 */
/**
 * @typedef {Object} XrefCloseResult - window.__xref.close resolution.
 * @property {boolean} ok
 * @property {boolean} [value] - success only: the real bridge's closeXrefContext result
 * @property {string} [code] - refusal only: an ERR_XREF_* code
 */
/**
 * @typedef {Object} XrefBridgeStub - window.__xref, installed by installBridge: thin page-side wrappers over window.jcad's xref methods that resolve to the result bags above instead of throwing.
 * @property {(docId: string) => Promise<XrefBeginResult>} begin
 * @property {(token: string, path: string) => Promise<XrefIdentifyResult>} identify
 * @property {(token: string, ticket: string, maxBytes: number) => Promise<XrefReadResult>} read
 * @property {(token: string) => Promise<XrefCloseResult>} close
 */
/**
 * @typedef {Object} XrefGraphNode - one node of the loader's resolved xref graph, as flattened by the G1 in-page code (src/io/xref-loading.ts).
 * @property {string} blockName
 * @property {string} status
 * @property {string | null} resolvedPath
 * @property {boolean} overlay
 * @property {number} depth
 * @property {XrefGraphNode[]} children
 */
/**
 * @typedef {Object} XrefStoreSnapshot - the loader's staged snapshot the G1 code reads: the node graph, plus the load stats, which the harness only serializes into its results (never inspects field by field).
 * @property {XrefGraphNode[]} nodes
 * @property {unknown} stats
 */
/**
 * @typedef {Object} XrefLoadFailure - one loader failure record, as mapped by the G1 in-page code.
 * @property {string} kind
 * @property {string} blockName
 * @property {string} message
 */
/**
 * @typedef {Object} XrefLoadOutcome - the bundled XrefStore.load/refresh resolution, as read by the G1 in-page code.
 * @property {boolean} committed
 * @property {boolean} preserved
 * @property {XrefLoadFailure[]} failures
 * @property {XrefStoreSnapshot | null} current
 */
/**
 * @typedef {Object} XrefLoadInput - the store input the G1 code builds: the opened drawing's block table (passed through opaquely) and the host path.
 * @property {{ blocks: unknown }} hostState
 * @property {string} hostPath
 */
/**
 * @typedef {Object} XrefReaderHandle - the adapter handle from the bundled createXrefReader (src/app/xref-reader.ts): the harness hands .reader to the store and awaits .dispose().
 * @property {object} reader
 * @property {() => Promise<void>} dispose
 */
/**
 * @typedef {Object} XrefAdapterBridge - the FileBridge-shaped subset the bundled createXrefReader consumes; the G1 code builds it directly over window.jcad.
 * @property {(info: { docId: string, contentGeneration: (number | string), hostAnchor: string }) => Promise<{ token: string }>} beginXrefContext
 * @property {(token: string, path: string) => Promise<{ ticket: string, identity: XrefFileIdentity }>} identifyXref
 * @property {(token: string, ticket: string, maxBytes: number) => Promise<{ text: string, byteLength: number, version: string, rawBytes: number, rawSha256: string }>} readXref
 * @property {(token: string) => Promise<boolean>} cancelXref
 * @property {(token: string) => Promise<boolean>} closeXrefContext
 */
/**
 * @typedef {Object} XrefStoreLike - the members of the bundled XrefStore the G1 code calls.
 * @property {(input: XrefLoadInput, opts: { reader: object }) => Promise<XrefLoadOutcome>} load
 * @property {(input: XrefLoadInput, opts: { reader: object }) => Promise<XrefLoadOutcome>} refresh
 */
/**
 * @typedef {Object} XrefExternalEntry - one entry of the bundled externalContent(snapshot): the source node, the file evidence, and the parsed entities (each serialized through the semantic oracle before any comparison).
 * @property {{ blockName: string, resolvedPath: (string | null) }} node
 * @property {{ version: (string | null), byteLength: number }} file
 * @property {object[]} entities
 */
/**
 * @typedef {Object} XrefSigEntry - one entry of the G1 semantic signature the in-page sig() builds from externalContent.
 * @property {string} block
 * @property {string | null} path
 * @property {string | null} version
 * @property {number} byteLength
 * @property {string[]} entities
 */
/**
 * @typedef {Object} XrefG1Session - window.__xrefG1: the live in-page loader session installed by g1LoadInPage.
 * @property {XrefStoreLike} store
 * @property {XrefReaderHandle} handle
 * @property {XrefLoadInput} input
 * @property {(snap: XrefStoreSnapshot) => XrefSigEntry[]} sig
 */
/**
 * @typedef {Record<string, unknown> & {
 *   XrefStore: new () => XrefStoreLike,
 *   collectXrefReferences: (host: { blocks: unknown }) => Array<{ blockName: string, path: string, overlay?: boolean }>,
 *   createXrefReader: (bridge: XrefAdapterBridge, opts: { docId: string, contentGeneration: (number | string), hostPath: string }) => XrefReaderHandle,
 *   externalContent: (snap: XrefStoreSnapshot) => XrefExternalEntry[],
 * }} XrefCoreBundle - window.__xrefCore: the esbuild bundle of the accepted loader/adapter sources, injected by the harness (buildBundle). The Record constituent covers the name-based member probe in section 3.3.
 */
/**
 * @typedef {Object} XrefPageGlobals - the window members this harness installs and uses inside evaluate callbacks. Every member is optional: each is absent from the page until the harness installs it (installBridge, bundle injection, or a section's own setup), which is also what makes the XrefPageWindow cast of the plain DOM Window a plain widening of the declared window shape.
 * @property {XrefBridgeStub} [__xref]
 * @property {string} [__xrefHost]
 * @property {string} [__xrefHostPath]
 * @property {XrefCoreBundle} [__xrefCore]
 * @property {(entity: object) => string} [__xrefSemanticEntityJson]
 * @property {XrefG1Session | null} [__xrefG1]
 * @property {Promise<XrefReadResult>} [__xrefBurstHeld]
 * @property {XrefChainLoopFn} [__xrefChainLoop]
 * @property {XrefChainState} [__xrefChain]
 * @property {string} [__xrefToken]
 * @property {Promise<XrefReadResult>} [__xrefHeldRead]
 */
/**
 * @typedef {Object} XrefChainLoopResult - the renewal chain loop's final accounting, resolved by its done promise (xrefChainLoopImpl's return).
 * @property {number} links
 * @property {number} errors
 * @property {number} totalBytes
 * @property {string | null} lastError
 */
/**
 * @typedef {Object} XrefChainSummary - the chain summary the harness collects (chainCollectionDecisionImpl's return): the loop's final accounting plus the drain marker.
 * @property {number} links
 * @property {number} errors
 * @property {number} totalBytes
 * @property {string | null} lastError
 * @property {boolean} drained - true ONLY when the chain's done promise resolved with the final accounted state; false for timeout / rejection / missing state / fallback counters (diagnostics only, never witness-eligible)
 */
/**
 * @typedef {Object} XrefChainState - the section 3.3 renewal chain's page-side state, installed by the burst's start evaluate. It is also the loop's caller-owned state handle: the loop mutates the counters and reads `stopped`; stop() (or the self-test) requests a stop by setting it.
 * @property {number} links
 * @property {number} errors
 * @property {number} totalBytes
 * @property {boolean} stopped
 * @property {string | null} lastError
 * @property {Promise<XrefChainLoopResult> | null} done
 * @property {() => void} stop
 */
/**
 * @typedef {Object} XrefChainLoopOpts - xrefChainLoopImpl's bounds and caller-owned state.
 * @property {number} maxLinks
 * @property {number} busyRetries
 * @property {number} expectBytes
 * @property {XrefChainState} state
 */
/** @typedef {(readFn: () => Promise<XrefReadResult>, opts: XrefChainLoopOpts) => Promise<XrefChainLoopResult>} XrefChainLoopFn - the renewal chain loop (xrefChainLoopImpl), serialized into the page as window.__xrefChainLoop. */
/**
 * @typedef {Object} XrefChainCollectionInput - chainCollectionDecisionImpl's input: how collecting the chain's done promise ended.
 * @property {'resolved' | 'timeout' | 'rejected' | 'missing'} outcome
 * @property {XrefChainLoopResult | null} summary - the done promise's resolution (outcome 'resolved' only)
 * @property {XrefChainLoopResult | null} fallbackCounters - live page counters read after a non-resolved outcome (diagnostics only)
 */
/** @typedef {Window & XrefPageGlobals} XrefPageWindow */
/**
 * @typedef {Object} XrefBrokerStats - the observer facade's raw aggregate stats (sample() in scripts/xref-test-observer.cjs).
 * @property {number} contexts
 * @property {number} tickets
 * @property {number} activeOps
 * @property {number} retiredActiveOps
 * @property {number} reservedRawBytes
 * @property {boolean} disposed
 */
/**
 * @typedef {Object} XrefObserverSample - one sample from the observer facade.
 * @property {number} seq
 * @property {number} atMs
 * @property {boolean} captured
 * @property {number} factoryCalls
 * @property {string | null} invalidated
 * @property {XrefBrokerStats | null} stats
 */
/**
 * @typedef {Object} CorrelationRecord - runCorrelation's per-launch outcome, stored on the launch's observer state and in results.correlations.
 * @property {string} label
 * @property {boolean} ok
 * @property {string} reason
 * @property {boolean} beginOk
 * @property {boolean} closeOk
 * @property {number | null} afterBeginSeq
 * @property {number | null} afterCloseSeq
 */
/**
 * @typedef {Object} LaunchObserverState - ONE launch's own observer coverage (captured by launchApp): its zero baseline, whether that baseline was a clean zero capture, and - once runCorrelation has run for the launch - its same-broker correlation record.
 * @property {XrefObserverSample | null} baseline
 * @property {boolean} usable
 * @property {CorrelationRecord} [correlation]
 */

// ------------------------------------------------------------ semantic entity oracle (finding 1)
// The ONE definition of the refresh comparator. It is injected into the
// renderer verbatim from this function's own source (see
// SEMANTIC_ENTITY_FN_SOURCE) and the --self-test-oracle regression below
// calls this very function object, so the tested code is the shipped
// code. Source facts it relies on (verified in the accepted tree):
// commonProps (src/io/dxf/read-core.ts:32) builds every parsed entity
// with `id: newId()` (src/core/entities.ts:372 - a Date.now/counter
// string, fresh per parse) and puts the retained native handle in
// `cadIdentity` (DXF group 5). EntityBase declares no other generated
// identity; entities embed no nested entity objects (INSERT attributes
// are a tag -> string record). So EXACTLY the top-level `id` is
// transient; everything else - geometry, cadIdentity, layer, retained
// properties - is file content and must compare.
function semanticEntityJsonImpl(entity) {
  const copy = { ...entity };
  delete copy.id;
  const canon = (v) => {
    if (v === null || typeof v !== 'object') {
      const s = JSON.stringify(v);
      return s === undefined ? 'null' : s;
    }
    if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  };
  return canon(copy);
}
const SEMANTIC_ENTITY_FN_SOURCE = `window.__xrefSemanticEntityJson = ${semanticEntityJsonImpl.toString()};`;

// ------------------------------------------------------------ same-broker correlation (round 3, group 2)
// The ONE pass/blocked decision for a launch's same-broker correlation.
// Pure bookkeeping: it decides only from the launch's own baseline
// stats and the two correlation samples (after-begin S, after-close
// S2), including their factoryCalls/invalidated fields. Contract:
//   pass  <=> S shows contexts = baseline+1 with activeOps and
//             reservedRawBytes still AT baseline (a real context
//             exists, no active/reserved work before any read), under
//             factoryCalls === 1 and no invalidation, AND S2 shows
//             contexts and tickets back AT baseline after the close.
//   anything else -> blocked, with the specific reason.
function correlationDecisionImpl(baselineStats, s, s2) {
  const blocked = (reason) => ({ verdict: 'blocked', reason });
  const usable = (x) => Boolean(x && x.captured && x.stats);
  if (!baselineStats) return blocked('no baseline stats for this launch');
  if (!usable(s)) return blocked('no usable correlation sample after the real begin');
  if (s.invalidated) return blocked(`observer coverage invalidated: ${s.invalidated}`);
  if (s.factoryCalls !== 1) return blocked(`one-instance proof failed at the correlation sample (factoryCalls=${s.factoryCalls})`);
  if (s.stats.contexts !== baselineStats.contexts + 1) return blocked(`observed contexts=${s.stats.contexts} after a real begin, expected baseline+1=${baselineStats.contexts + 1}: the observed broker is not proven to be the bridge's broker`);
  if (s.stats.activeOps !== baselineStats.activeOps) return blocked(`active work present at the correlation sample, before any read (activeOps=${s.stats.activeOps}, baseline=${baselineStats.activeOps})`);
  if (s.stats.reservedRawBytes !== baselineStats.reservedRawBytes) return blocked(`reserved bytes present at the correlation sample, before any read (reservedRawBytes=${s.stats.reservedRawBytes}, baseline=${baselineStats.reservedRawBytes})`);
  if (!usable(s2)) return blocked('no usable correlation sample after the real close');
  if (s2.invalidated) return blocked(`observer coverage invalidated: ${s2.invalidated}`);
  if (s2.factoryCalls !== 1) return blocked(`one-instance proof failed at the post-close sample (factoryCalls=${s2.factoryCalls})`);
  if (s2.stats.contexts !== baselineStats.contexts) return blocked(`contexts did not return to baseline after the close (contexts=${s2.stats.contexts}, baseline=${baselineStats.contexts})`);
  if (s2.stats.tickets !== baselineStats.tickets) return blocked(`tickets did not return to baseline after the close (tickets=${s2.stats.tickets}, baseline=${baselineStats.tickets})`);
  return { verdict: 'pass', reason: '' };
}

// Oracle regression, runnable without Electron:
//   node scripts/e2e-xref-refresh.mjs --self-test-oracle
// Exit 0 only if: (a) same geometry/properties with different generated
// ids (and shuffled key order) compare EQUAL; (b) one changed
// coordinate compares NOT equal; (c) one changed retained property
// (layer, then linetype) compares NOT equal; (d) a changed retained
// handle (cadIdentity) compares NOT equal.
if (process.argv.includes('--self-test-oracle')) {
  const sem = semanticEntityJsonImpl;
  const lineA = { id: 'emt0a1', cadIdentity: '2F', layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } };
  const lineTwin = { b: { y: 0, x: 10 }, a: { y: 0, x: 0 }, type: 'line', color: 'ByLayer', layer: '0', cadIdentity: '2F', id: 'emz9q77' };
  const cases = [
    ['(a) same geometry+properties, different generated ids -> EQUAL', sem(lineA) === sem(lineTwin), true],
    ['(b) one changed coordinate (b.y 0 -> 1) -> NOT equal', sem(lineA) === sem({ ...lineA, b: { x: 10, y: 1 } }), false],
    ['(c1) one changed retained property (layer) -> NOT equal', sem(lineA) === sem({ ...lineA, layer: 'WALLS' }), false],
    ['(c2) one changed retained property (linetype) -> NOT equal', sem(lineA) === sem({ ...lineA, linetype: 'DASHED' }), false],
    ['(d) one changed retained handle (cadIdentity) -> NOT equal', sem(lineA) === sem({ ...lineA, cadIdentity: '30' }), false],
  ];
  let okAll = true;
  for (const [name, got, want] of cases) {
    const ok = got === want;
    okAll = okAll && ok;
    console.log(`${ok ? 'ok  ' : 'FAIL'} self-test-oracle ${name} (equal=${got}, expected equal=${want})`);
  }
  console.log(`self-test-oracle: ${okAll ? 'PASS' : 'FAIL'}`);
  process.exit(okAll ? 0 : 1);
}

// Correlation bookkeeping regression, runnable without Electron:
//   node scripts/e2e-xref-refresh.mjs --self-test-correlation
// Exit 0 only if correlationDecisionImpl (the very function the live
// run uses) decides: perfect correlation -> pass; contexts not
// baseline+1 after begin -> blocked; reserved bytes present at the
// correlation sample -> blocked; active work at the correlation sample
// -> blocked; close not returning contexts/tickets to baseline ->
// blocked; a second broker instance or invalidated coverage -> blocked.
if (process.argv.includes('--self-test-correlation')) {
  const B = { contexts: 0, tickets: 0, activeOps: 0, retiredActiveOps: 0, reservedRawBytes: 0, disposed: false };
  const mk = (over = {}, fields = {}) => ({ seq: 7, atMs: 1234, captured: true, factoryCalls: 1, invalidated: null, stats: { ...B, ...over }, ...fields });
  const cases = [
    ['(a) perfect correlation (begin -> contexts+1, quiet; close -> baseline) -> pass', correlationDecisionImpl(B, mk({ contexts: 1 }), mk({})).verdict, 'pass'],
    ['(b) contexts not baseline+1 after begin -> blocked', correlationDecisionImpl(B, mk({ contexts: 0 }), mk({})).verdict, 'blocked'],
    ['(c) reserved bytes nonzero at the correlation sample -> blocked', correlationDecisionImpl(B, mk({ contexts: 1, reservedRawBytes: 4097 }), mk({})).verdict, 'blocked'],
    ['(d) active work at the correlation sample -> blocked', correlationDecisionImpl(B, mk({ contexts: 1, activeOps: 1 }), mk({})).verdict, 'blocked'],
    ['(e) close does not return contexts to baseline -> blocked', correlationDecisionImpl(B, mk({ contexts: 1 }), mk({ contexts: 1 })).verdict, 'blocked'],
    ['(f) close does not return tickets to baseline -> blocked', correlationDecisionImpl(B, mk({ contexts: 1 }), mk({ tickets: 1 })).verdict, 'blocked'],
    ['(g) second broker instance (factoryCalls = 2) -> blocked', correlationDecisionImpl(B, mk({ contexts: 1 }, { factoryCalls: 2 }), mk({})).verdict, 'blocked'],
    ['(h) invalidated coverage -> blocked', correlationDecisionImpl(B, mk({ contexts: 1 }, { invalidated: 'second-broker-instance' }), mk({})).verdict, 'blocked'],
    ['(i) no usable sample after begin -> blocked', correlationDecisionImpl(B, null, mk({})).verdict, 'blocked'],
  ];
  let okAll = true;
  for (const [name, got, want] of cases) {
    const ok = got === want;
    okAll = okAll && ok;
    console.log(`${ok ? 'ok  ' : 'FAIL'} self-test-correlation ${name} (verdict=${got}, expected=${want})`);
  }
  console.log(`self-test-correlation: ${okAll ? 'PASS' : 'FAIL'}`);
  process.exit(okAll ? 0 : 1);
}

// ------------------------------------------------------------ tab-removal precondition (section 3.5a)
// The ONE decision for the 3.5a precondition "the host tab is
// actually removed before the read". Pure: it decides only from the
// pre-close capture { count, hostDocId, hostPath } (the 3.5 setup
// evaluate) and the post-close capture { count, paths, docIds,
// soleUntitled } (one evaluate after sessions.close). Removed means:
//   the host path is absent from the post-close paths AND the host
//   docId is absent from the post-close docIds, AND the count moved
//   in one of the two truthful shapes:
//   - normal: count === preCount - 1 (one of several tabs closed);
//   - last tab: preCount === 1 and count === 1 with the sole
//     remaining session untitled - SessionManager.close
//     (src/app/sessions.ts) replaces an emptied list with one fresh
//     blank drawing (filePath null, fresh docId), so the count does
//     NOT drop when the only tab closes. (The docId-absence clause
//     already requires that remaining session to be a different
//     document than the host.)
function tabRemovalDecisionImpl(pre, post) {
  if (!pre || !post) return false;
  if (typeof pre.hostDocId !== 'string' || pre.hostDocId === '') return false;
  if (!Array.isArray(post.paths) || !Array.isArray(post.docIds)) return false;
  if (post.paths.includes(pre.hostPath)) return false;
  if (post.docIds.includes(pre.hostDocId)) return false;
  if (post.count === pre.count - 1) return true;
  if (pre.count === 1 && post.count === 1 && post.soleUntitled === true) return true;
  return false;
}

// Tab-removal regression, runnable without Electron:
//   node scripts/e2e-xref-refresh.mjs --self-test-tab-removal
// Exit 0 only if tabRemovalDecisionImpl (the very function the live
// 3.5a check uses) decides: normal close (one of several tabs) ->
// removed; last-tab close (blank replacement) -> removed; host path
// still listed -> NOT removed; host docId still listed -> NOT
// removed; last-tab count but the remaining session is a file
// session -> NOT removed.
if (process.argv.includes('--self-test-tab-removal')) {
  const HP = 'C:\\fx\\drawings\\host.dxf';
  const pre3 = { count: 3, hostDocId: 'doc-host', hostPath: HP };
  const pre1 = { count: 1, hostDocId: 'doc-host', hostPath: HP };
  const cases = [
    ['(a) normal shape (3 tabs -> 2, host path+docId absent) -> removed', tabRemovalDecisionImpl(pre3, { count: 2, paths: ['C:\\fx\\a.dxf', 'C:\\fx\\b.dxf'], docIds: ['doc-a', 'doc-b'], soleUntitled: false }), true],
    ['(b) last-tab shape (1 -> 1, sole session a fresh untitled blank) -> removed', tabRemovalDecisionImpl(pre1, { count: 1, paths: [null], docIds: ['doc-blank'], soleUntitled: true }), true],
    ['(c) host path still in the list -> NOT removed', tabRemovalDecisionImpl(pre3, { count: 2, paths: [HP, 'C:\\fx\\a.dxf'], docIds: ['doc-a', 'doc-b'], soleUntitled: false }), false],
    ['(d) host docId still in the list -> NOT removed', tabRemovalDecisionImpl(pre3, { count: 2, paths: ['C:\\fx\\a.dxf', 'C:\\fx\\b.dxf'], docIds: ['doc-host', 'doc-b'], soleUntitled: false }), false],
    ['(e) last-tab count but the remaining session has a file path -> NOT removed', tabRemovalDecisionImpl(pre1, { count: 1, paths: ['C:\\fx\\other.dxf'], docIds: ['doc-other'], soleUntitled: false }), false],
  ];
  let okAll = true;
  for (const [name, got, want] of cases) {
    const ok = got === want;
    okAll = okAll && ok;
    console.log(`${ok ? 'ok  ' : 'FAIL'} self-test-tab-removal ${name} (removed=${got}, expected removed=${want})`);
  }
  console.log(`self-test-tab-removal: ${okAll ? 'PASS' : 'FAIL'}`);
  process.exit(okAll ? 0 : 1);
}

// ------------------------------------------------------------ burst overlap witness (section 3.3, design v2)
// Renewal-chain bounds (lead-approved PLAN-3.3-WITNESS): the chain
// stops ITSELF at CHAIN_MAX_LINKS links even if never told to stop;
// the harness stops it explicitly right after S3 regardless. The BUSY
// refusal gets at most CHAIN_REFUSAL_ATTEMPTS competing reads (an
// attempt admitted in an inter-link gap completes a real read and is
// logged, then retried). A chain link that meets the harness's own
// gap-admitted competing read retries the refusal - each retry is one
// IPC round trip, so CHAIN_BUSY_RETRIES is a livelock guard, not a
// timing oracle.
const CHAIN_MAX_LINKS = 64;
const CHAIN_REFUSAL_ATTEMPTS = 5;
const CHAIN_BUSY_RETRIES = 50;

// The ONE pass/blocked decision for the section 3.3 observer-bound
// overlap criterion. Pure: it decides only from the three burst
// samples, the renewal chain's final summary, the slow fixture size,
// and the two gate verdicts the caller computed with the existing
// plumbing (observer usability, same-broker correlation). The sample
// predicate is the SHIPPED one, unchanged: a sample shows the burst
// context busy iff activeOps >= 1 AND reservedRawBytes ===
// slowBytes + 1 (one active op reserving the slow file plus the
// sentinel byte). Contract:
//   pass    <=> every sample satisfies the predicate AND the chain is
//               healthy: links >= 3 (the window was genuinely covered
//               by back-to-back full reads), errors === 0, and
//               totalBytes === links * slowBytes (every link returned
//               exactly the full file; bytes are also verified per
//               link in the page before they are counted) AND the
//               chain's drain was positively confirmed
//               (chain.drained === true - its done promise resolved
//               with this final accounted state; H2).
//   blocked <=> anything else, with the specific reason: unusable
//               observer coverage, unproven correlation, a sample
//               that failed the predicate (insufficient witness - a
//               sample may have landed in an inter-link gap, or the
//               chain ended early), an unhealthy/absent chain, or a
//               chain summary whose drain was not positively
//               confirmed (its counters are then diagnostics only and
//               are never read for a verdict).
// A miss can ONLY produce blocked, never pass.
function burstWitnessDecisionImpl({ s1, s2, s3, chain, slowBytes, correlationOk, observerOk }) {
  const blocked = (reason) => ({ verdict: 'blocked', reason });
  if (!observerOk) return blocked('observer coverage unusable for the burst samples');
  if (!correlationOk) return blocked('same-broker correlation unproven for this launch');
  const aActive = (s) => Boolean(s && s.stats && s.stats.activeOps >= 1 && s.stats.reservedRawBytes === slowBytes + 1);
  const act = [aActive(s1), aActive(s2), aActive(s3)];
  if (!act.every(Boolean)) {
    return blocked(`insufficient witness: the burst context was not proven active at every bound step (S1 seq=${s1?.seq ?? null} active=${act[0]}, S2 seq=${s2?.seq ?? null} active=${act[1]}, S3 seq=${s3?.seq ?? null} active=${act[2]}) - a sample may have landed in an inter-link gap or the chain ended early; never passed by default`);
  }
  if (!chain) return blocked('no renewal-chain summary was collected for the burst: chain health unproven');
  if (chain.drained !== true) return blocked('renewal chain drain was not positively confirmed (the done promise did not resolve with the final accounted state): the collected counters are diagnostics only and cannot carry the witness');
  if (chain.errors !== 0) return blocked(`renewal chain recorded ${chain.errors} failed link(s) (last: ${chain.lastError ?? 'unknown'}): chain health unproven`);
  if (!(chain.links >= 3)) return blocked(`renewal chain completed only ${chain.links} link(s) (< 3): the burst window was not covered by back-to-back genuine full reads`);
  if (chain.totalBytes !== chain.links * slowBytes) return blocked(`renewal chain byte accounting mismatch (totalBytes=${chain.totalBytes}, links=${chain.links}, slowBytes=${slowBytes}): per-link byte verification unproven`);
  return { verdict: 'pass', reason: '' };
}

// The renewal chain loop itself (section 3.3). It runs in the PAGE
// (installed from this function's own serialized source - see
// XREF_CHAIN_LOOP_FN_SOURCE below), and --self-test-burst drives THIS
// VERY function object with scripted fake read functions, so the
// regression exercises the shipped loop, not a re-implementation.
// Fully self-contained (no closure over harness state): every input
// arrives via readFn / opts, because the source is serialized.
//   readFn: one chain link's read, issued fresh per link (and per
//     BUSY retry); resolves with the bridge read result bag.
//   opts.state: the caller-owned state handle. The loop mutates the
//     counters and reads state.stopped; the caller requests a stop by
//     setting state.stopped (the page's chain.stop()). Stop is
//     consulted ONLY (a) in the loop condition, before issuing the
//     NEXT link, and (b) as a gate on retrying a BUSY refusal - a
//     retry is a NEW issuance. The settled outcome of an
//     ALREADY-ISSUED read is validated and accounted FIRST, whatever
//     the stop flag says (H1): a refusal/error increments errors, a
//     wrong rawBytes increments errors, a good read increments links
//     and totalBytes - stop never erases a pending outcome, so a
//     late error or short read stays non-passing.
// Resolves with the final accounted state { links, errors,
// totalBytes, lastError } - only then is the chain drained (H2).
/**
 * @param {() => Promise<XrefReadResult>} readFn
 * @param {XrefChainLoopOpts} opts
 * @returns {Promise<XrefChainLoopResult>}
 */
async function xrefChainLoopImpl(readFn, opts) {
  const { maxLinks, busyRetries, expectBytes, state } = opts;
  while (!state.stopped && state.links < maxLinks) {
    let r = null;
    let busyLeft = busyRetries;
    for (;;) {
      try { r = await readFn(); } catch (e) { r = { ok: false, code: String(e && e.message || e) }; }
      // A BUSY refusal of an issued read is retried as a NEW issuance
      // of the same link (the harness's own gap-admitted competing
      // read holds the context briefly), but only while retries
      // remain AND no stop was requested; otherwise this settled
      // outcome is the link's final outcome and is accounted below.
      if (r && !r.ok && r.code === 'ERR_XREF_RESOURCE_BUSY' && busyLeft > 0 && !state.stopped) {
        busyLeft -= 1;
        continue;
      }
      break;
    }
    // H1: account the link's settled outcome UNCONDITIONALLY, before
    // the stop flag can end the loop. An error/refusal or a short
    // read is a chain error and ends the chain.
    if (!r || !r.ok) { state.errors += 1; state.lastError = r ? (r.code ?? 'read refused') : 'read returned nothing'; break; }
    if (r.rawBytes !== expectBytes) { state.errors += 1; state.lastError = `link returned rawBytes=${r.rawBytes}, expected ${expectBytes}`; break; }
    state.links += 1;
    state.totalBytes += r.rawBytes;
  }
  state.stopped = true;
  return { links: state.links, errors: state.errors, totalBytes: state.totalBytes, lastError: state.lastError };
}
const XREF_CHAIN_LOOP_FN_SOURCE = `window.__xrefChainLoop = ${xrefChainLoopImpl.toString()};`;

// The ONE decision for collecting the chain's final summary after a
// stop (section 3.3). Pure and timing-free: the caller classifies how
// awaiting the done promise ended (the live bound is the harness's
// 60 s race) and this function decides what the collection MEANS.
//   outcome 'resolved' with a well-formed summary => the summary,
//     drained: true - the ONLY witness-eligible shape (H2): the done
//     promise resolved only after the loop validated and accounted
//     every already-issued read and exited.
//   anything else (timeout / rejected / missing / malformed) =>
//     drained: false; the counters come from fallbackCounters when
//     available and are DIAGNOSTICS ONLY - burstWitnessDecisionImpl
//     refuses them a verdict regardless of their values.
/**
 * @param {XrefChainCollectionInput} input
 * @returns {XrefChainSummary}
 */
function chainCollectionDecisionImpl({ outcome, summary, fallbackCounters }) {
  const wellFormed = (s) => Boolean(s && typeof s.links === 'number' && typeof s.errors === 'number' && typeof s.totalBytes === 'number');
  if (outcome === 'resolved' && wellFormed(summary)) {
    return { links: /** @type {XrefChainLoopResult} */ (summary).links, errors: /** @type {XrefChainLoopResult} */ (summary).errors, totalBytes: /** @type {XrefChainLoopResult} */ (summary).totalBytes, lastError: /** @type {XrefChainLoopResult} */ (summary).lastError ?? null, drained: true };
  }
  const diag = wellFormed(fallbackCounters) ? fallbackCounters : null;
  return { links: diag?.links ?? 0, errors: diag?.errors ?? 0, totalBytes: diag?.totalBytes ?? 0, lastError: diag?.lastError ?? null, drained: false };
}

// Burst witness regression, runnable without Electron:
//   node scripts/e2e-xref-refresh.mjs --self-test-burst
// Exit 0 only if the shipped functions decide as specified.
// Fixed-summary cases on burstWitnessDecisionImpl: (a) the OLD
// orchestration's trace - one held read active at S1/S2 but finished
// before S3, no chain - is BLOCKED as insufficient witness (the
// portable fail-first: the shipped predicate on the old shape);
// (b) a healthy, positively drained chain trace passes; (c) a chain
// with an error link blocks; (d) a chain with too few links blocks;
// (e) a sample whose reservation is not exactly the slow size +
// sentinel blocks; (f) unusable observer coverage blocks;
// (g) unproven correlation blocks; (h) healthy counters whose drain
// was NOT positively confirmed block (H2); (i) a summary with no
// drained marker at all blocks (H2).
// Live-loop cases drive xrefChainLoopImpl ITSELF with scripted fake
// reads (controllable deferreds) and chainCollectionDecisionImpl on
// the outcomes: (L1) three good links + a fourth pending, stop
// requested mid-fourth, the fourth settles as an ERROR -> the error
// is accounted (errors=1), not discarded (H1), and the witness
// blocks; (L2) the fourth settles SHORT -> errors=1, blocked;
// (L3) the fourth never settles -> collection outcome 'timeout' with
// healthy live counters decides drained=false and the witness
// blocks (H2); (L4) collection outcomes 'rejected' / 'missing'
// decide drained=false and block; (L5) POSITIVE CONTROL: the fourth
// settles good, no fifth read is issued after the stop, collection
// 'resolved' decides drained=true and the witness passes;
// (L6) a BUSY refusal of a link is retried as a new issuance and
// counted once, and a good read settling after a stop request is
// still accounted (H1).
if (process.argv.includes('--self-test-burst')) {
  const SIZE = 16 * 1024 * 1024;
  const mkS = (activeOps, reservedRawBytes, seq) => ({ seq, atMs: seq * 10, captured: true, factoryCalls: 1, invalidated: null, stats: { contexts: 2, tickets: 2, activeOps, retiredActiveOps: 0, reservedRawBytes, disposed: false } });
  const on = (seq) => mkS(1, SIZE + 1, seq);
  const off = (seq) => mkS(0, 0, seq);
  const healthy = { links: 5, errors: 0, totalBytes: 5 * SIZE, lastError: null, drained: true };
  const base = { slowBytes: SIZE, correlationOk: true, observerOk: true };
  const cases = [
    ['(a) old-shape trace (active, active, INACTIVE at S3; no chain) -> blocked', burstWitnessDecisionImpl({ ...base, s1: on(1), s2: on(2), s3: off(3), chain: null }).verdict, 'blocked'],
    ['(b) chain trace (all samples active + healthy drained chain) -> pass', burstWitnessDecisionImpl({ ...base, s1: on(1), s2: on(2), s3: on(3), chain: healthy }).verdict, 'pass'],
    ['(c) healthy samples but one error link in the chain -> blocked', burstWitnessDecisionImpl({ ...base, s1: on(1), s2: on(2), s3: on(3), chain: { ...healthy, errors: 1, lastError: 'ERR_XREF_CHANGED' } }).verdict, 'blocked'],
    ['(d) healthy samples but the chain completed only 1 link -> blocked', burstWitnessDecisionImpl({ ...base, s1: on(1), s2: on(2), s3: on(3), chain: { links: 1, errors: 0, totalBytes: SIZE, lastError: null, drained: true } }).verdict, 'blocked'],
    ['(e) samples active but reservedRawBytes = 2*(size+1) at S2 -> blocked', burstWitnessDecisionImpl({ ...base, s1: on(1), s2: mkS(2, 2 * (SIZE + 1), 2), s3: on(3), chain: healthy }).verdict, 'blocked'],
    ['(f) observer coverage unusable -> blocked', burstWitnessDecisionImpl({ ...base, observerOk: false, s1: on(1), s2: on(2), s3: on(3), chain: healthy }).verdict, 'blocked'],
    ['(g) same-broker correlation unproven -> blocked', burstWitnessDecisionImpl({ ...base, correlationOk: false, s1: on(1), s2: on(2), s3: on(3), chain: healthy }).verdict, 'blocked'],
    ['(h) healthy counters but drain NOT positively confirmed (drained=false) -> blocked', burstWitnessDecisionImpl({ ...base, s1: on(1), s2: on(2), s3: on(3), chain: { ...healthy, drained: false } }).verdict, 'blocked'],
    ['(i) healthy counters but no drained marker at all -> blocked', burstWitnessDecisionImpl({ ...base, s1: on(1), s2: on(2), s3: on(3), chain: { links: 5, errors: 0, totalBytes: 5 * SIZE, lastError: null } }).verdict, 'blocked'],
  ];
  let okAll = true;
  const report = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    okAll = okAll && ok;
    console.log(`${ok ? 'ok  ' : 'FAIL'} self-test-burst ${name} (got=${JSON.stringify(got)}, expected=${JSON.stringify(want)})`);
  };
  for (const [name, got, want] of cases) report(name, got, want);
  const aReason = burstWitnessDecisionImpl({ ...base, s1: on(1), s2: on(2), s3: off(3), chain: null }).reason;
  const aOk = aReason.includes('insufficient witness');
  okAll = okAll && aOk;
  console.log(`${aOk ? 'ok  ' : 'FAIL'} self-test-burst (a2) the old-shape block reason names the insufficient witness (reason=${JSON.stringify(aReason)})`);

  // ---- live-loop scenarios: the REAL xrefChainLoopImpl, scripted reads
  const deferred = () => {
    /** @type {(v: XrefReadResult) => void} */
    let resolveFn = () => {};
    const promise = new Promise((res) => { resolveFn = res; });
    return { promise, resolve: resolveFn };
  };
  /** @returns {XrefChainState} */
  const newChainState = () => ({ stopped: false, links: 0, errors: 0, totalBytes: 0, lastError: null, done: null, stop() { this.stopped = true; } });
  // Spin (bounded) until the loop has issued n reads.
  const untilCalls = async (counter, n) => { for (let i = 0; i < 10000 && counter.n < n; i += 1) await new Promise((r) => setImmediate(r)); };
  const healthySamples = { ...base, s1: on(1), s2: on(2), s3: on(3) };
  // Three immediately-good links, then a fourth read the scenario
  // holds pending and settles by hand.
  const threeGoodThenHeld = () => {
    const counter = { n: 0 };
    const held = deferred();
    /** @returns {Promise<XrefReadResult>} */
    const readFn = () => {
      counter.n += 1;
      if (counter.n <= 3) return Promise.resolve({ ok: true, rawBytes: SIZE });
      return held.promise;
    };
    return { counter, held, readFn };
  };

  { // (L1) H1: stop mid-fourth; fourth settles as an ERROR.
    const { counter, held, readFn } = threeGoodThenHeld();
    const state = newChainState();
    const doneP = xrefChainLoopImpl(readFn, { maxLinks: 64, busyRetries: 0, expectBytes: SIZE, state });
    await untilCalls(counter, 4);
    report('(L1) setup: three good links accounted, fourth read issued', [state.links, state.errors, counter.n], [3, 0, 4]);
    state.stop();
    held.resolve({ ok: false, code: 'ERR_XREF_IO' });
    const summary = await doneP;
    report('(L1) H1: the late error is accounted, not discarded (errors=1, links stay 3)', [summary.errors, summary.links, summary.totalBytes], [1, 3, 3 * SIZE]);
    const collected = chainCollectionDecisionImpl({ outcome: 'resolved', summary, fallbackCounters: null });
    report('(L1) collection resolved -> drained=true, counters carried', [collected.drained, collected.errors], [true, 1]);
    report('(L1) witness on the accounted-error chain -> blocked', burstWitnessDecisionImpl({ ...healthySamples, chain: collected }).verdict, 'blocked');
  }
  { // (L2) H1: stop mid-fourth; fourth settles SHORT.
    const { counter, held, readFn } = threeGoodThenHeld();
    const state = newChainState();
    const doneP = xrefChainLoopImpl(readFn, { maxLinks: 64, busyRetries: 0, expectBytes: SIZE, state });
    await untilCalls(counter, 4);
    state.stop();
    held.resolve({ ok: true, rawBytes: SIZE - 1 });
    const summary = await doneP;
    report('(L2) H1: the late short read is accounted (errors=1, links stay 3)', [summary.errors, summary.links, summary.totalBytes], [1, 3, 3 * SIZE]);
    const collected = chainCollectionDecisionImpl({ outcome: 'resolved', summary, fallbackCounters: null });
    report('(L2) witness on the short-read chain -> blocked', burstWitnessDecisionImpl({ ...healthySamples, chain: collected }).verdict, 'blocked');
  }
  { // (L3) H2: fourth NEVER settles; the done promise stays pending,
    // so the collection (the harness's bounded race) times out while
    // the live counters look perfectly healthy.
    const { counter, readFn } = threeGoodThenHeld();
    const state = newChainState();
    void xrefChainLoopImpl(readFn, { maxLinks: 64, busyRetries: 0, expectBytes: SIZE, state });
    await untilCalls(counter, 4);
    state.stop();
    const collected = chainCollectionDecisionImpl({ outcome: 'timeout', summary: null, fallbackCounters: { links: state.links, errors: state.errors, totalBytes: state.totalBytes, lastError: state.lastError } });
    report('(L3) H2: timeout collection -> drained=false, healthy counters kept as diagnostics only', [collected.drained, collected.links, collected.errors], [false, 3, 0]);
    report('(L3) H2: witness on an undrained summary -> blocked despite healthy counters', burstWitnessDecisionImpl({ ...healthySamples, chain: collected }).verdict, 'blocked');
  }
  { // (L4) H2: collection outcomes 'rejected' and 'missing'.
    const healthyCounters = { links: 3, errors: 0, totalBytes: 3 * SIZE, lastError: null };
    const rej = chainCollectionDecisionImpl({ outcome: 'rejected', summary: null, fallbackCounters: healthyCounters });
    const mis = chainCollectionDecisionImpl({ outcome: 'missing', summary: null, fallbackCounters: null });
    report('(L4) H2: rejected collection -> drained=false', rej.drained, false);
    report('(L4) H2: missing collection -> drained=false, zero diagnostic counters', [mis.drained, mis.links, mis.totalBytes], [false, 0, 0]);
    report('(L4) H2: witness on rejected/missing collections -> blocked', [burstWitnessDecisionImpl({ ...healthySamples, chain: rej }).verdict, burstWitnessDecisionImpl({ ...healthySamples, chain: mis }).verdict], ['blocked', 'blocked']);
  }
  { // (L5) POSITIVE CONTROL: fourth settles good after the stop
    // request; the loop accounts it and issues NO fifth read.
    const { counter, held, readFn } = threeGoodThenHeld();
    const state = newChainState();
    const doneP = xrefChainLoopImpl(readFn, { maxLinks: 64, busyRetries: 0, expectBytes: SIZE, state });
    await untilCalls(counter, 4);
    state.stop();
    held.resolve({ ok: true, rawBytes: SIZE });
    const summary = await doneP;
    report('(L5) control: late good read accounted; stop prevented any fifth issuance', [summary.links, summary.errors, summary.totalBytes, counter.n], [4, 0, 4 * SIZE, 4]);
    const collected = chainCollectionDecisionImpl({ outcome: 'resolved', summary, fallbackCounters: null });
    report('(L5) control: resolved collection -> drained=true', collected.drained, true);
    report('(L5) control: witness passes on the healthy drained chain', burstWitnessDecisionImpl({ ...healthySamples, chain: collected }).verdict, 'pass');
  }
  { // (L6) BUSY retry + H1 accounting of a post-stop good read.
    const counter = { n: 0 };
    const state = newChainState();
    /** @returns {Promise<XrefReadResult>} */
    const readFn = () => {
      counter.n += 1;
      if (counter.n === 1) return Promise.resolve({ ok: false, code: 'ERR_XREF_RESOURCE_BUSY' });
      if (counter.n === 4) state.stop();
      return Promise.resolve({ ok: true, rawBytes: SIZE });
    };
    const summary = await xrefChainLoopImpl(readFn, { maxLinks: 64, busyRetries: 50, expectBytes: SIZE, state });
    report('(L6) BUSY retried as a new issuance (4 calls, 3 links, 0 errors); the post-stop good read is accounted', [counter.n, summary.links, summary.errors, summary.totalBytes], [4, 3, 0, 3 * SIZE]);
  }

  console.log(`self-test-burst: ${okAll ? 'PASS' : 'FAIL'}`);
  process.exit(okAll ? 0 : 1);
}

// ------------------------------------------------------------ setup (fail closed)
const workRootArg = argOf('--work-root');
const fixtureArg = argOf('--fixtures');
const outArg = argOf('--out');
const sectionsArg = argOf('--sections');
const sections = sectionsArg ? sectionsArg.split(',').map((s) => s.trim()).filter(Boolean) : ['3.1', '3.2', '3.3', '3.4', '3.5'];
function setupFail(message) {
  console.error(`e2e-xref-refresh: invalid setup: ${message}`);
  process.exit(2);
}
// G2 observer (lead ruling, implementation for review): when --observer
// names the pinned test-only observer file, launches preload it through
// the Electron CLI --require route (default_app) and the harness records
// read-only stats samples. Stats criteria evaluate ONLY from valid
// samples; otherwise they stay BLOCKED. Execution of the observer is a
// separately admitted native step - this delivery does not run it.
const observerArg = argOf('--observer');
const observerTargetSha = argOf('--observer-target-sha');
const observerMode = observerArg !== '';
let observerPath = '';
let observerSha256 = '';
if (observerMode) {
  observerPath = resolve(observerArg);
  if (!existsSync(observerPath)) setupFail('--observer file does not exist');
  if (!/^[0-9a-f]{64}$/.test(observerTargetSha)) setupFail('--observer-target-sha must be the pinned 64-hex sha256 of electron/xref-read.cjs from the delivery manifest');
  const actualTarget = fileSha(join(repo, 'electron', 'xref-read.cjs'));
  if (actualTarget !== observerTargetSha) setupFail(`--observer-target-sha (${observerTargetSha}) does not match electron/xref-read.cjs (${actualTarget}) - refusing to launch`);
  observerSha256 = fileSha(observerPath);
}
// Stage 2 packaged mode (admitted 2026-10-18, test-only): --packaged-exe
// names the executable of an UNPACKED test build (npm run dist:test ->
// release-test/win-unpacked/JCad Electrical.exe). When present, every
// launch targets that binary through Playwright's executablePath and
// drops the development app-path argument '.'; when absent, launches
// are byte-for-byte the Stage 1 development launches. No check, sample
// criterion or verdict changes in either mode. The packaged broker
// loads from app.asar while the observer's pinned target stays anchored
// to this source tree (scripts/xref-test-observer.cjs), so in packaged
// mode observer capture is not expected and stats criteria BLOCK by
// design - see the Stage 2 packaged runbook.
const packagedExeArg = argOf('--packaged-exe');
const packagedMode = packagedExeArg !== '';
let packagedExe = '';
let packagedExeSha256 = '';
if (packagedMode) {
  packagedExe = resolve(packagedExeArg);
  if (!existsSync(packagedExe)) setupFail('--packaged-exe file does not exist');
  packagedExeSha256 = fileSha(packagedExe);
}
if (!workRootArg) setupFail('--work-root is required (fixtures, out, profiles and TEMP are confined under it)');
if (!fixtureArg) setupFail('--fixtures is required');
if (!outArg) setupFail('--out is required');
const workRoot = resolve(workRootArg);
mkdirSync(workRoot, { recursive: true });
const insideWork = (p, what) => {
  const rel = relative(workRoot, p);
  if (rel === '' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) setupFail(`${what} (${p}) must be a directory inside --work-root (${workRoot})`);
  return p;
};
const fixtureDir = insideWork(resolve(fixtureArg), '--fixtures');
const outDir = insideWork(resolve(outArg), '--out');
const tempDir = join(workRoot, 'temp');
mkdirSync(tempDir, { recursive: true });
try {
  mkdirSync(outDir, { recursive: true });
} catch (error) {
  // The out dir is where ALL run evidence lands; if it cannot be
  // created there is no run worth starting (finding 5).
  setupFail(`--out (${outDir}) cannot be created as the evidence directory: ${String(error && error.message || error)}`);
}

const fx = (rel) => join(fixtureDir, ...rel.split('/'));
if (!existsSync(fx('fixtures.json'))) setupFail(`fixtures.json not found in ${fixtureDir} - run scripts/xref-native-fixtures.mjs first`);
const fixtureMeta = JSON.parse(readFileSync(fx('fixtures.json'), 'utf8'));
if (fixtureMeta.version !== 2 || !fixtureMeta.files || !fixtureMeta.edits) setupFail('fixtures.json is not the v2 layout - regenerate the fixtures');
for (const rel of ['mutable.dxf', 'shared/leaf.dxf']) {
  const e = fixtureMeta.edits[rel];
  if (!e || typeof e.locate !== 'string' || typeof e.replace !== 'string' || typeof e.editedSha256 !== 'string') setupFail(`fixtures.json lacks a pinned edit descriptor for ${rel}`);
}
if (typeof fixtureMeta.edits['mutable.dxf'].grownSha256 !== 'string') setupFail('fixtures.json lacks the pinned grown hash for mutable.dxf');
const manifestText = readFileSync(fx('SHA256SUMS.txt'), 'utf8');
const manifestSha = sha256(Buffer.from(manifestText));
{
  const manifestLines = manifestText.trim().split('\n').map((l) => l.trim()).filter(Boolean).sort();
  const expectLines = Object.entries(fixtureMeta.files).map(([rel, m]) => `${m.sha256}  ${rel}`).sort();
  if (JSON.stringify(manifestLines) !== JSON.stringify(expectLines)) setupFail('SHA256SUMS.txt does not match the fixtures.json file set/hashes');
}
for (const [rel, meta] of Object.entries(fixtureMeta.files)) {
  if (!existsSync(fx(rel))) setupFail(`fixture ${rel} is missing`);
  const buf = readFileSync(fx(rel));
  if (buf.length !== meta.bytes || sha256(buf) !== meta.sha256) setupFail(`fixture ${rel} does not match fixtures.json - regenerate the fixtures`);
}
const projectRel = fixtureMeta.project;
const hostRel = 'drawings/host.dxf';
const leafRel = 'shared/leaf.dxf';
if (!fixtureMeta.files[projectRel] || !fixtureMeta.files[hostRel]) setupFail('fixtures.json lacks the project file or the host drawing');
const projectPath = fx(projectRel);
const hostPath = fx(hostRel);
const hostHashBefore = fixtureMeta.files[hostRel].sha256;

// ------------------------------------------------------------ result records
const logLines = [];
const log = (line) => { logLines.push(line); console.log(line); };
const checks = [];
let currentSection = 'setup';
let halted = false;
let haltReason = '';
function record(status, name, detail = '') {
  checks.push({ section: currentSection, name, status, detail });
  log(`${status === 'pass' ? 'ok  ' : status === 'fail' ? 'FAIL' : status.toUpperCase().padEnd(4)} [${currentSection}] ${name}${detail ? ` - ${detail}` : ''}`);
}
function check(pass, name, detail = '') { record(pass ? 'pass' : 'fail', name, detail); return Boolean(pass); }
function blocked(name, reason = G2_REASON) { record('blocked', name, reason); }
function failHalt(name, detail = '') {
  record('fail', name, detail);
  halted = true;
  haltReason = `stopped at the first failed PASS criterion: [${currentSection}] ${name}`;
}
const results = { header: {}, checks, observer: { mode: observerMode ? 'cli-require via default_app' : 'off', path: observerPath || null, sha256: observerSha256 || null, targetSha256: observerTargetSha || null }, observerSamples: [], observerBaseline: null, correlations: {}, residue: { workRoot, fixtureDir, outDir, tempDir, profiles: [], childExits: [], watchdogFired: false, deleted: 'nothing (residue preserved by design)' } };
// Evidence persistence (finding 5): a run that cannot write its
// evidence has NOT passed, whatever the checks say. Any write failure
// is reported explicitly on stderr/stdout and forces exit code 3 at
// every exit path; partial files and stdout are preserved as the
// surviving record.
let evidenceFailed = false;
function writeResults() {
  const failures = [];
  try { writeFileSync(join(outDir, 'harness.log'), logLines.join('\n') + '\n'); } catch (error) { failures.push(`harness.log: ${String(error && error.message || error)}`); }
  try { writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2) + '\n'); } catch (error) { failures.push(`results.json: ${String(error && error.message || error)}`); }
  if (failures.length) {
    evidenceFailed = true;
    console.error(`e2e-xref-refresh: EVIDENCE FAILURE - run evidence could not be persisted (${failures.join(' | ')}); exit code will be 3 and stdout/partial files are the surviving record`);
  }
  return failures.length === 0;
}

// ------------------------------------------------------------ watchdog + owned processes
const children = new Set();
function trackChild(label, child) {
  if (!child) return;
  const entry = { label, child, exitCode: undefined };
  children.add(entry);
  child.once('exit', (code) => { entry.exitCode = code; results.residue.childExits.push({ label, code }); });
}
function killChild(entry) {
  const { child } = entry;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5_000, windowsHide: true });
    } else child.kill('SIGKILL');
  } catch { /* already gone */ }
}
const watchdog = setTimeout(() => {
  results.residue.watchdogFired = true;
  log('FAIL watchdog: 10 minutes elapsed - terminating ONLY this harness\'s own Electron processes');
  for (const entry of children) killChild(entry);
  record('fail', 'global watchdog fired (10 min)');
  writeResults();
  process.exit(evidenceFailed ? 3 : 1);
}, 10 * 60 * 1000);
watchdog.unref();

function waitForExit(child, ms) {
  return new Promise((done) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return done(child ? child.exitCode : null);
    const onExit = () => { clearTimeout(timer); done(child.exitCode); };
    const timer = setTimeout(() => { child.removeListener('exit', onExit); done(null); }, ms);
    child.once('exit', onExit);
  });
}

// ------------------------------------------------------------ child env (whitelist)
function childEnv() {
  const env = /** @type {Record<string, string>} */ ({});
  for (const k of ['PATH', 'SystemRoot', 'windir']) if (process.env[k]) env[k] = process.env[k];
  env.TEMP = tempDir;
  env.TMP = tempDir;
  env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1';
  if (observerMode) {
    // The reviewed runner supplies the observer's fail-closed opt-in and
    // the pinned target identity - and nothing else extra.
    env.JCAD_XREF_TEST_OBSERVER = '1';
    env.JCAD_XREF_OBSERVER_TARGET_SHA256 = observerTargetSha;
  }
  // Non-Windows only: a headless X server is the launch mechanism itself.
  if (process.platform !== 'win32') {
    if (process.env.DISPLAY) env.DISPLAY = process.env.DISPLAY;
    if (process.env.XAUTHORITY) env.XAUTHORITY = process.env.XAUTHORITY;
  }
  return env;
}

// ------------------------------------------------------------ loader bundle (G1)
/** @type {string | null} */
let bundleText = null;
/** @type {string | null} */
let bundleError = null;
/** @type {{ bytes: number, sha256: string } | null} */
let bundleInfo = null;
async function buildBundle() {
  const entryPath = join(outDir, 'xref-core-entry.ts');
  const toImport = (p) => p.replace(/\\/g, '/');
  writeFileSync(entryPath, [
    `export { XrefStore, collectXrefReferences, externalContent } from '${toImport(join(repo, 'src/io/xref-loading.ts'))}';`,
    `export { createXrefReader } from '${toImport(join(repo, 'src/app/xref-reader.ts'))}';`,
    '',
  ].join('\n'));
  // Emulate Vite's `?raw` suffix (the app build's own semantics): the
  // module default export is the referenced file's text content.
  const rawPlugin = {
    name: 'vite-raw',
    setup(b) {
      b.onResolve({ filter: /\?raw$/ }, (args) => ({ path: resolve(dirname(args.importer), args.path.replace(/\?raw$/, '')), namespace: 'raw' }));
      b.onLoad({ filter: /.*/, namespace: 'raw' }, (args) => ({ contents: `export default ${JSON.stringify(readFileSync(args.path, 'utf8'))};`, loader: 'js' }));
    },
  };
  const outfile = join(outDir, 'xref-core.bundle.js');
  await esbuildBuild({
    entryPoints: [entryPath], bundle: true, format: 'iife', globalName: '__xrefCore',
    platform: 'browser', target: 'es2022', plugins: [rawPlugin], outfile, logLevel: 'silent',
  });
  const buf = readFileSync(outfile);
  bundleText = buf.toString('utf8');
  bundleInfo = { bytes: buf.length, sha256: sha256(buf) };
}

// ------------------------------------------------------------ app driving
async function launchApp(label) {
  if (packagedMode) log(`launch[${label}]: packaged exe ${packagedExe} (sha256 ${packagedExeSha256.slice(0, 12)}..)`);
  const profile = join(workRoot, `profile-${label}`);
  mkdirSync(profile, { recursive: true });
  results.residue.profiles.push(profile);
  const args = packagedMode
    ? [...(observerMode ? ['--require', observerPath] : []), `--user-data-dir=${profile}`]
    : observerMode
      ? ['--require', observerPath, '.', `--user-data-dir=${profile}`]
      : ['.', `--user-data-dir=${profile}`];
  if (process.platform === 'linux') args.push('--no-sandbox');
  // Packaged launches run with cwd inside the work root: the packaged
  // tree is evidence, not a working directory (Stage 1 decision C -
  // driver residue such as NVIDIA umdlogs lands in the cwd).
  const app = packagedMode
    ? await electron.launch({ executablePath: packagedExe, args, cwd: workRoot, env: childEnv(), timeout: 90_000 })
    : await electron.launch({ args, cwd: repo, env: childEnv(), timeout: 60_000 });
  trackChild(label, app.process());
  const win = await applicationWindow(app);
  const pageErrors = [];
  win.on('pageerror', (e) => pageErrors.push(String(e.message)));
  await win.waitForFunction(() => !!window.editor, null, { timeout: 30_000 });
  await app.evaluate(({ dialog }) => {
    const g = globalThis;
    g.__xrefOpenPaths = [];
    dialog.showOpenDialog = async () => {
      const p = g.__xrefOpenPaths.shift();
      return p ? { canceled: false, filePaths: [p] } : { canceled: true, filePaths: [] };
    };
  });
  // Per-instance observer coverage (finding 2): EVERY launch captures
  // its OWN zero baseline immediately after window-ready, before any
  // begin on this instance. Coverage is never borrowed from another app.
  /** @type {LaunchObserverState | null} */
  let observer = null;
  if (observerMode) {
    const baseline = await sampleObserver(app, `baseline:${label}`);
    const bs = baseline?.stats;
    const usable = Boolean(baseline && baseline.captured && baseline.factoryCalls === 1 && !baseline.invalidated && bs
      && bs.contexts === 0 && bs.tickets === 0 && bs.activeOps === 0 && bs.retiredActiveOps === 0 && bs.reservedRawBytes === 0 && bs.disposed === false);
    observer = { baseline, usable };
    log(`observer[${label}]: baseline ${JSON.stringify(baseline)} usable=${usable}`);
    if (!usable) log(`observer[${label}]: WARNING - baseline not a clean zero capture; stats-derived criteria for THIS launch will be BLOCKED`);
  }
  return { app, win, pageErrors, profile, observer };
}

// ------------------------------------------------------------ G2 observer sampling
// Coverage state is PER APP INSTANCE: launchApp captures { baseline,
// usable } for each launch and callers pass that launch's own state.
// There is deliberately no global baseline to fall back to.
async function sampleObserver(appInstance, tag) {
  if (!observerMode) return null;
  try {
    const s = await appInstance.evaluate(() => {
      const f = globalThis.__xrefTestObserver;
      return f ? f.sample() : null;
    });
    results.observerSamples.push({ tag, sample: s });
    return s;
  } catch {
    return null;
  }
}
function observerUsable(state, s) {
  return Boolean(state && state.usable && s && s.captured && s.factoryCalls === 1 && !s.invalidated && s.stats);
}
function observerBlockReason(state, s) {
  if (!observerMode) return 'observer not enabled for this run (no --observer): stats criteria stay BLOCKED under the G2 ruling';
  if (!state || !state.usable) return 'this launch\'s observer baseline was not a clean zero capture: stats coverage invalid for this instance';
  if (!s) return 'observer facade absent or sampling failed: stats coverage invalid for this run';
  if (s.invalidated) return `observer coverage invalidated: ${s.invalidated}`;
  if (!s.captured || s.factoryCalls !== 1) return `observer one-instance proof failed (captured=${s.captured}, factoryCalls=${s.factoryCalls})`;
  return 'observer sample unusable';
}
const CORRELATION_REASON = 'same-broker correlation unproven for this launch';
function correlationBlockReason(state) {
  if (!observerMode) return `${CORRELATION_REASON}: observer not enabled for this run (no --observer)`;
  const c = state?.correlation;
  if (!c) return `${CORRELATION_REASON}: correlation was not run for this launch`;
  return `${CORRELATION_REASON}: ${c.reason}`;
}
// Same-broker correlation for ONE launch (round 3, group 2): a real
// bridge begin on this launch's window, a sample that must show the
// context at baseline+1 with no active/reserved work, a real bridge
// close, and a sample back at baseline. Runs immediately after the
// bridge is installed for the launch, before any scenario context
// work. Never throws: the outcome is recorded on the launch's observer
// state and in results.correlations, and GATES every stats-derived
// check for the launch (missing correlation -> BLOCKED, never pass).
async function runCorrelation(label, launch) {
  const state = launch?.observer;
  if (!observerMode || !state) return null;
  const record = { label, ok: false, reason: '', beginOk: false, closeOk: false, afterBeginSeq: null, afterCloseSeq: null };
  const finish = (reason) => {
    record.reason = reason;
    state.correlation = record;
    results.correlations[label] = record;
    log(`observer[${label}]: same-broker correlation ${record.ok ? 'PROVEN' : `UNPROVEN - ${reason}`}`);
    return record;
  };
  if (!state.usable) return finish('this launch\'s observer baseline was not a clean zero capture');
  try {
    const begun = await launch.win.evaluate((d) => /** @type {XrefPageWindow} */ (window).__xref.begin(d), `correlation-${label}`);
    record.beginOk = Boolean(begun?.ok);
    if (!begun?.ok) return finish(`real bridge begin for correlation failed: ${JSON.stringify(begun)}`);
    const s = await sampleObserver(launch.app, `correlation:${label}:after-begin`);
    record.afterBeginSeq = s?.seq ?? null;
    const closed = await launch.win.evaluate((t) => /** @type {XrefPageWindow} */ (window).__xref.close(t), begun.token);
    record.closeOk = Boolean(closed?.ok);
    const s2 = await sampleObserver(launch.app, `correlation:${label}:after-close`);
    record.afterCloseSeq = s2?.seq ?? null;
    if (!closed?.ok) return finish(`real bridge close for correlation failed: ${JSON.stringify(closed)}`);
    const decision = correlationDecisionImpl(state.baseline.stats, s, s2);
    if (decision.verdict !== 'pass') return finish(decision.reason);
    record.ok = true;
    return finish('');
  } catch (error) {
    return finish(`correlation sequence threw: ${String(error && error.message || error)}`);
  }
}
async function statsZeroCheck(appInstance, state, name) {
  const s = await sampleObserver(appInstance, name);
  if (!state?.correlation?.ok) { blocked(name, correlationBlockReason(state)); return; }
  if (!observerUsable(state, s)) { blocked(name, observerBlockReason(state, s)); return; }
  const st = s.stats;
  const b = state.baseline.stats;
  check(st.activeOps === 0 && st.reservedRawBytes === 0 && st.contexts === b.contexts && st.tickets === b.tickets && st.retiredActiveOps === b.retiredActiveOps,
    name, `sample=${JSON.stringify(st)} baseline=${JSON.stringify(b)}`);
}

async function openProjectAndHost(app, win) {
  // Genuine Open Project first: main registers every listed fixture
  // drawing as readable by name (the designed project mechanism).
  await app.evaluate((_e, p) => globalThis.__xrefOpenPaths.push(p), projectPath);
  const projOk = await win.evaluate(() => window.editor.openProject());
  if (!projOk) throw new Error('the genuine Open Project flow did not open the fixture project');
  const listed = await win.evaluate(() => window.editor.project.drawings.length);
  const expected = Object.keys(fixtureMeta.files).filter((rel) => rel.endsWith('.dxf')).length;
  if (listed !== expected) throw new Error(`project listed ${listed} drawings, expected ${expected}`);
  // Then the genuine OPEN of the host drawing.
  await app.evaluate((_e, p) => globalThis.__xrefOpenPaths.push(p), hostPath);
  await win.evaluate(() => void window.editor.runCommand('OPEN'));
  await win.waitForFunction((p) => window.editor.doc.filePath === p, hostPath, { timeout: 30_000 });
  for (let i = 0; i < 5 && (await win.locator('.import-report-dialog').count()) > 0; i += 1) {
    await win.locator('.import-report-dialog .modal button', { hasText: 'Close' }).last().click();
    await win.waitForTimeout(200);
  }
  return listed;
}

/** Page-side raw bridge helpers: { ok, ... } or { ok:false, code }; text only for small reads. */
async function installBridge(win) {
  await win.evaluate(() => {
    const code = (e) => {
      const m = /ERR_XREF_[A-Z_]+/.exec(String(e));
      return m ? m[0] : String(e);
    };
    /** @type {XrefPageWindow} */ (window).__xref = {
      async begin(docId) {
        try {
          const r = await window.jcad.beginXrefContext({ docId, contentGeneration: 1, hostAnchor: /** @type {XrefPageWindow} */ (window).__xrefHost });
          return { ok: true, token: r.token };
        } catch (e) { return { ok: false, code: code(e) }; }
      },
      async identify(token, path) {
        try {
          const r = await window.jcad.identifyXref(token, path);
          return { ok: true, ticket: r.ticket, identity: r.identity };
        } catch (e) { return { ok: false, code: code(e) }; }
      },
      async read(token, ticket, maxBytes) {
        try {
          const r = await window.jcad.readXref(token, ticket, maxBytes);
          return { ok: true, byteLength: r.byteLength, rawBytes: r.rawBytes, rawSha256: r.rawSha256, version: r.version, text: r.rawBytes <= 65536 ? r.text : undefined };
        } catch (e) { return { ok: false, code: code(e) }; }
      },
      async close(token) {
        try { return { ok: true, value: await window.jcad.closeXrefContext(token) }; }
        catch (e) { return { ok: false, code: code(e) }; }
      },
    };
    /** @type {XrefPageWindow} */ (window).__xrefHost = /** @type {XrefPageWindow} */ (window).__xrefHostPath;
  });
}

async function closeBounded(app) {
  if (!app) return;
  const child = app.process();
  await Promise.race([app.close().catch(() => {}), new Promise((done) => setTimeout(done, 15_000))]);
  if (child && child.exitCode === null && child.signalCode === null) {
    for (const entry of children) if (entry.child === child) killChild(entry);
    await waitForExit(child, 5_000);
  }
}

// ------------------------------------------------------------ G1 in-page (real loader + adapter)
async function g1LoadInPage(win, docId) {
  return win.evaluate(async (cfg) => {
    const core = /** @type {XrefPageWindow} */ (window).__xrefCore;
    const ed = window.editor;
    const snapJson = () => { try { return JSON.stringify(ed.doc.snapshot); } catch { return null; } };
    const docState = () => ({ json: snapJson(), dirty: ed.doc.dirty, revision: ed.doc.revision });
    const before = docState();
    const blocks = ed.doc.snapshot.blocks;
    const references = core.collectXrefReferences({ blocks });
    const bridge = {
      beginXrefContext: (info) => window.jcad.beginXrefContext(info),
      identifyXref: (t, p) => window.jcad.identifyXref(t, p),
      readXref: (t, k, m) => window.jcad.readXref(t, k, m),
      cancelXref: (t) => window.jcad.cancelXref(t),
      closeXrefContext: (t) => window.jcad.closeXrefContext(t),
    };
    const handle = core.createXrefReader(bridge, { docId: cfg.docId, contentGeneration: ed.doc.revision, hostPath: cfg.hostPath });
    const store = new core.XrefStore();
    const input = { hostState: { blocks }, hostPath: cfg.hostPath };
    const flatten = (nodes, acc = []) => {
      for (const n of nodes) {
        acc.push({ block: n.blockName, status: n.status, path: n.resolvedPath, overlay: n.overlay, depth: n.depth });
        flatten(n.children, acc);
      }
      return acc;
    };
    const sem = /** @type {XrefPageWindow} */ (window).__xrefSemanticEntityJson;
    if (typeof sem !== 'function') throw new Error('semantic entity serializer was not injected (window.__xrefSemanticEntityJson missing) - refusing to fall back to raw serialization');
    // Semantic signature (finding 1): block/path/version/byteLength bind
    // the node's source identity as before; entities serialize through
    // the semantic oracle (canonical JSON minus ONLY the parser-generated
    // top-level id), so a re-parse of unchanged bytes compares EQUAL.
    const sig = (snap) => core.externalContent(snap).map((e) => ({
      block: e.node.blockName, path: e.node.resolvedPath, version: e.file.version ?? null,
      byteLength: e.file.byteLength, entities: e.entities.map((x) => sem(x)),
    }));
    try {
      const r = await store.load(input, { reader: handle.reader });
      /** @type {XrefPageWindow} */ (window).__xrefG1 = { store, handle, input, sig };
      return {
        references, before, after: docState(),
        load: {
          committed: r.committed, preserved: r.preserved,
          failures: r.failures.map((f) => ({ kind: f.kind, block: f.blockName, message: f.message })),
          nodes: r.current ? flatten(r.current.nodes) : [],
          sig: r.current ? sig(r.current) : null,
          stats: r.current ? r.current.stats : null,
        },
      };
    } catch (e) {
      return { references, before, after: docState(), error: String(e && e.message || e) };
    }
  }, { docId, hostPath });
}

async function g1RefreshInPage(win) {
  return win.evaluate(async () => {
    const g = /** @type {XrefPageWindow} */ (window).__xrefG1;
    if (!g) return { error: 'no G1 loader session in this page' };
    try {
      const r = await g.store.refresh(g.input, { reader: g.handle.reader });
      return {
        committed: r.committed,
        failures: r.failures.map((f) => ({ kind: f.kind, block: f.blockName, message: f.message })),
        sig: r.current ? g.sig(r.current) : null,
      };
    } catch (e) {
      return { error: String(e && e.message || e) };
    }
  });
}

async function g1DisposeInPage(win) {
  await win.evaluate(async () => {
    const g = /** @type {XrefPageWindow} */ (window).__xrefG1;
    if (g) { try { await g.handle.dispose(); } catch { /* recorded by the run, not fatal here */ } /** @type {XrefPageWindow} */ (window).__xrefG1 = null; }
  }).catch(() => {});
}

/** Compute the pinned edited bytes for a fixture from its current bytes. Throws on any mismatch. */
function pinnedEditedBytes(original, rel) {
  const desc = fixtureMeta.edits[rel];
  if (sha256(original) !== fixtureMeta.files[rel].sha256) throw new Error(`${rel} is not at its pinned bytes before the edit`);
  const text = original.toString('utf8');
  const at = text.indexOf(desc.locate);
  if (at < 0 || text.indexOf(desc.locate, at + 1) >= 0) throw new Error(`${rel}: pinned locate string not found exactly once`);
  const edited = Buffer.from(text.slice(0, at) + desc.replace + text.slice(at + desc.locate.length), 'utf8');
  if (sha256(edited) !== desc.editedSha256) throw new Error(`${rel}: edited bytes do not match the pinned edited hash`);
  return edited;
}

/** Apply a fixtures.json pinned edit to a fixture file; returns the original bytes. Throws on any mismatch. */
function applyPinnedEdit(rel) {
  const original = readFileSync(fx(rel));
  writeFileSync(fx(rel), pinnedEditedBytes(original, rel));
  return original;
}

/** Restore a fixture file in a finally; a failed restore is a failed check and halts the run (G4). */
function restoreFixture(rel, original) {
  writeFileSync(fx(rel), original);
  const restored = sha256(readFileSync(fx(rel))) === fixtureMeta.files[rel].sha256;
  check(restored, `${rel} restored to its pinned bytes (finally)`);
  if (!restored) { halted = true; haltReason = `${rel} could not be restored to its pinned bytes - fixture evidence preserved as failed`; }
  return restored;
}

const normPath = (p) => (typeof p === 'string' ? p.replace(/\\/g, '/') : p);
const sigEntry = (sig, suffix) => (sig ?? []).find((e) => normPath(e.path).endsWith(suffix));
const leafLine = (entry) => {
  for (const s of entry?.entities ?? []) {
    try { const e = JSON.parse(s); if (e && e.type === 'line') return e; } catch { /* not JSON */ }
  }
  return null;
};

// ------------------------------------------------------------ main flow
let app; let win; let pageErrors = [];
let mainObserver = null; // the main launch's OWN observer coverage state
let g1 = null; // { sig } after a successful in-page load
const sourceIdentity = {
  xrefLoadingSha256: fileSha(join(repo, 'src/io/xref-loading.ts')),
  xrefReaderSha256: fileSha(join(repo, 'src/app/xref-reader.ts')),
  distIndexHtmlSha256: fileSha(join(repo, 'dist/index.html')),
  harnessScriptSha256: fileSha(join(repo, 'scripts/e2e-xref-refresh.mjs')),
  fixtureGeneratorSha256: fileSha(join(repo, 'scripts/xref-native-fixtures.mjs')),
};
try {
  if (!existsSync(join(repo, 'dist', 'index.html'))) throw new Error('dist/index.html not found: run `npm run build` first');
  try {
    await buildBundle();
  } catch (error) {
    bundleError = String(error && error.message || error);
  }
  const mainLaunch = await launchApp('main');
  ({ app, win, pageErrors } = mainLaunch);
  mainObserver = mainLaunch.observer;
  results.observerBaseline = mainObserver?.baseline ?? null;
  const versions = await app.evaluate(() => process.versions);
  const appInfo = await win.evaluate(() => window.jcad.appInfo());
  results.header = {
    electron: versions.electron, chromium: versions.chrome, node: versions.node,
    app: appInfo, platform: process.platform,
    suppliedHead: argOf('--head') || '(not supplied)', suppliedTree: argOf('--tree') || '(not supplied)',
    suppliedLabelsNote: '--head/--tree are caller-supplied labels; the computed source identity below is what this run actually used',
    sourceIdentity: { ...sourceIdentity, bundle: bundleInfo ?? { error: bundleError } },
    fixtureManifestSha256: manifestSha, fixtureDir, workRoot,
    observer: results.observer,
    launchMode: packagedMode ? { mode: 'packaged', exe: packagedExe, exeSha256: packagedExeSha256 } : { mode: 'dev' },
    evidenceClass: process.platform === 'win32' ? 'windows-stage1' : 'mechanics-only-non-win32',
  };
  log(`header: electron ${versions.electron} / chromium ${versions.chrome} / node ${versions.node}`);
  log(`header: app ${JSON.stringify(appInfo)} on ${process.platform}`);
  log(`header: supplied head ${results.header.suppliedHead} tree ${results.header.suppliedTree} (labels)`);
  log(`header: source identity: xref-loading ${sourceIdentity.xrefLoadingSha256.slice(0, 12)}.., xref-reader ${sourceIdentity.xrefReaderSha256.slice(0, 12)}.., bundle ${bundleInfo ? `${bundleInfo.sha256.slice(0, 12)}.. (${bundleInfo.bytes} B)` : `FAILED: ${bundleError}`}, dist/index.html ${sourceIdentity.distIndexHtmlSha256.slice(0, 12)}..`);
  log(`header: fixture manifest sha256 ${manifestSha}`);
  if (packagedMode) log(`header: launch mode packaged - exe ${packagedExe} sha256 ${packagedExeSha256.slice(0, 12)}..`);
  if (packagedMode && observerMode) log('header: NOTE - packaged mode: the observer target is anchored to the source tree while the packaged broker loads from app.asar; observer capture is not expected and stats-derived criteria will BLOCK by design (Stage 2 runbook).');
  if (process.platform !== 'win32') log('header: WARNING - not win32: the bridge is win32-gated and the broker refuses non-Windows paths by design; this run validates harness mechanics only.');
  const listed = await openProjectAndHost(app, win);
  check(listed > 0, 'fixture project opened through the genuine Open Project flow (its drawings are registry-known)', `${listed} drawings listed`);
  await win.evaluate((p) => { /** @type {XrefPageWindow} */ (window).__xrefHostPath = p; }, hostPath);
  await installBridge(win);
  // Same-broker correlation for the MAIN launch (round 3, group 2),
  // immediately after the bridge is installed and before any section
  // context work: gates every main stats-derived check (3.2/3.3).
  await runCorrelation('main', mainLaunch);
  await win.screenshot({ path: join(outDir, 'host-open.png') });
  check(true, 'host drawing opened through the app OPEN flow', hostPath);
  check(pageErrors.length === 0, 'no page errors during launch/open', pageErrors.join(' | '));
  const bridgeOk = await win.evaluate(() => ['beginXrefContext', 'identifyXref', 'readXref', 'cancelXref', 'closeXrefContext'].every((k) => typeof window.jcad[k] === 'function'));
  check(bridgeOk, 'window.jcad exposes the five xref bridge methods (Windows-only in the preload by design)');
  if (!bridgeOk) failHalt('xref bridge unavailable on this platform/build - this gate requires the Windows app');
  // The main launch's observer baseline was captured inside launchApp
  // (per-instance, before any begin); nothing to re-sample here.

  const begin = (docId) => win.evaluate((d) => /** @type {XrefPageWindow} */ (window).__xref.begin(d), docId);
  const identify = (token, p) => win.evaluate(([t, q]) => /** @type {XrefPageWindow} */ (window).__xref.identify(t, q), [token, p]);
  const read = (token, ticket, max) => win.evaluate(([t, k, m]) => /** @type {XrefPageWindow} */ (window).__xref.read(t, k, m), [token, ticket, max]);
  const closeCtx = (token) => win.evaluate((t) => /** @type {XrefPageWindow} */ (window).__xref.close(t), token);
  const sectionWanted = (s) => sections.includes(s);
  const sectionFailed = (mark) => checks.slice(mark).some((c) => c.status === 'fail');

  // -------------------------------------------------------------- 3.1
  if (sectionWanted('3.1')) {
    currentSection = '3.1';
    const mark = checks.length;
    if (halted) record('skipped', 'section 3.1 (raw CHANGED controls)', haltReason);
    else {
      const ctx = await begin('native-3.1');
      check(ctx.ok, 'begin context', JSON.stringify(ctx));
      const idn = await identify(ctx.token, fx('mutable.dxf'));
      check(idn.ok, 'identify mutable.dxf', JSON.stringify(idn));
      const first = await read(ctx.token, idn.ticket, MIB);
      check(first.ok, 'first read of mutable.dxf succeeds', JSON.stringify(first));
      // Content, not metadata: for these ASCII fixtures the decoded text
      // is byte-identical to the file, so its hash must equal the pin.
      check(first.ok && typeof first.text === 'string' && sha256(Buffer.from(first.text, 'utf8')) === fixtureMeta.files['mutable.dxf'].sha256 && first.rawSha256 === fixtureMeta.files['mutable.dxf'].sha256,
        'first read returns the pinned CONTENT (decoded-text hash and raw hash)', JSON.stringify({ rawSha256: first.rawSha256 }));
      const original = readFileSync(fx('mutable.dxf'));
      const desc = fixtureMeta.edits['mutable.dxf'];
      try {
        writeFileSync(fx('mutable.dxf'), Buffer.concat([original, Buffer.from(' ')]));
        check(sha256(readFileSync(fx('mutable.dxf'))) === desc.grownSha256, 'growth applied at exactly the pinned grown bytes (+1 B)');
        const grown = await read(ctx.token, idn.ticket, MIB);
        check(!grown.ok && grown.code === 'ERR_XREF_CHANGED', 'grown file (+1 B) refuses CHANGED, never LIMIT', JSON.stringify(grown));
        writeFileSync(fx('mutable.dxf'), pinnedEditedBytes(original, 'mutable.dxf'));
        const changed = await read(ctx.token, idn.ticket, MIB);
        check(!changed.ok && changed.code === 'ERR_XREF_CHANGED', 'same-size coordinate edit (group 21 value) refuses CHANGED', JSON.stringify(changed));
        const idn2 = await identify(ctx.token, fx('mutable.dxf'));
        const reread = idn2.ok ? await read(ctx.token, idn2.ticket, MIB) : { ok: false };
        check(reread.ok && typeof reread.text === 'string' && sha256(Buffer.from(reread.text, 'utf8')) === desc.editedSha256,
          'fresh identify+read returns the edited CONTENT (pinned edited hash)', JSON.stringify({ rawSha256: reread.rawSha256 }));
      } finally {
        restoreFixture('mutable.dxf', original);
      }
      await closeCtx(ctx.token);
      if (sectionFailed(mark)) { halted = true; haltReason = 'stopped at the first failed PASS criterion in section 3.1'; }
    }
  }

  // -------------------------------------------------------------- 3.2
  if (sectionWanted('3.2')) {
    currentSection = '3.2';
    const mark = checks.length;
    if (halted) record('skipped', 'section 3.2 (raw LIMIT controls)', haltReason);
    else {
      const ctx = await begin('native-3.2');
      const big = await identify(ctx.token, fx('oversized.dxf'));
      check(big.ok, 'identify oversized.dxf', JSON.stringify(big));
      const refused = await read(ctx.token, big.ticket, 16 * MIB);
      check(!refused.ok && refused.code === 'ERR_XREF_LIMIT', 'oversized (16 MiB + 1) refuses LIMIT live', JSON.stringify(refused));
      const leaf = await identify(ctx.token, fx(leafRel));
      const leafSize = fixtureMeta.files[leafRel].bytes;
      const under = await read(ctx.token, leaf.ticket, leafSize - 1);
      check(!under.ok && under.code === 'ERR_XREF_LIMIT', 'allowance one below identified size refuses LIMIT', JSON.stringify(under));
      const fine = await read(ctx.token, leaf.ticket, MIB);
      check(fine.ok && typeof fine.text === 'string' && sha256(Buffer.from(fine.text, 'utf8')) === fixtureMeta.files[leafRel].sha256,
        'a normal read still succeeds after the refusals and returns the pinned leaf content', JSON.stringify(fine.ok ? { byteLength: fine.byteLength } : fine));
      await closeCtx(ctx.token);
      await statsZeroCheck(app, mainObserver, 'broker stats return to baseline after the LIMIT refusals and the explicit context close (activeOps / reservedRawBytes zero; contexts / tickets / retiredActiveOps back to baseline)');
      if (sectionFailed(mark)) { halted = true; haltReason = 'stopped at the first failed PASS criterion in section 3.2'; }
    }
  }

  // -------------------------------------------------------------- 3.3
  if (sectionWanted('3.3')) {
    currentSection = '3.3';
    const mark = checks.length;
    if (halted) record('skipped', 'section 3.3 (caps burst + real loader load)', haltReason);
    else {
      const ctxA = await begin('native-3.3-a');
      const slow = await identify(ctxA.token, fx('slow.dxf'));
      const leafA = await identify(ctxA.token, fx(leafRel));
      check(slow.ok && leafA.ok, 'context A identifies slow.dxf and leaf.dxf');
      // True-overlap orchestration (finding 2; witness design v2,
      // lead-approved PLAN-3.3-WITNESS): Node drives the burst in
      // steps instead of one opaque page evaluate, and observer
      // samples on the one main clock/sequence bind A's activity +
      // its reservation to the same-context refusal AND to B's
      // completion. A single held read cannot be trusted to span
      // S1..S3 - measured natively, growing slow.dxf to the 16 MiB
      // allowance ceiling widened the S1->S3 span to 172 ms but B's
      // completion moved with it (57 -> 167 ms), so size cannot win.
      // Instead a RENEWAL CHAIN of genuine full reads of slow.dxf
      // runs on context A from before S1 until after S3: each link
      // is a complete real read whose bytes are verified in the
      // page, and the next link starts in the same continuation.
      // The broker's ONE-active-op-per-context cap is respected by
      // construction - the chain is a sequence, never concurrent.
      // A link that meets the harness's own gap-admitted competing
      // read retries that BUSY refusal (bounded); any other refusal
      // or a byte mismatch is a chain error and stops the chain.
      // The loop is this file's xrefChainLoopImpl, serialized into
      // the page. The chain stops deterministically: the harness
      // stops it right after S3 (in a finally, so a harness error
      // cannot leave it running), and it stops itself at
      // CHAIN_MAX_LINKS even if never told. Two stop/drain rules
      // (Codex rerun-3 review H1/H2): every already-issued read is
      // validated and accounted BEFORE the stop flag is honored -
      // stop prevents the next issuance, never erases a pending
      // outcome, so a late error or short read stays non-passing -
      // and the summary carries the witness only on a POSITIVELY
      // confirmed drain (drained === true); a collection timeout,
      // rejection or missing state leaves it undrained and BLOCKED,
      // with live counters kept as diagnostics only. No artificial
      // holds, fake reads or sleeps-as-oracle: a sample that lands
      // in an inter-link gap or after an early chain end makes the
      // overlap criterion BLOCKED (insufficient witness), never
      // passed.
      const slowBytes = fixtureMeta.files['slow.dxf'].bytes;
      const burstSteps = [];
      const stepMark = (step, sample) => {
        const m = { step, seq: sample?.seq ?? null, atMs: sample?.atMs ?? null };
        burstSteps.push(m);
        results.burstSteps = burstSteps;
        return m;
      };
      const attempts = [];
      results.burstAttempts = attempts;
      // Stop the page-side chain and collect its final summary.
      // Never throws. The bounded race (60 s) classifies HOW awaiting
      // the chain's done promise ended - resolved with the final
      // accounted state / timeout / rejected / missing - and
      // chainCollectionDecisionImpl decides what the collection
      // means: only 'resolved' yields drained === true (H2). On any
      // other outcome the live counters are still read, but they
      // travel as diagnostics on an undrained summary and can never
      // carry the witness.
      const stopChainAndCollect = async () => {
        try { await win.evaluate(() => { /** @type {XrefPageWindow} */ (window).__xrefChain?.stop(); }); } catch { /* page may be gone */ }
        /** @type {'resolved' | 'timeout' | 'rejected' | 'missing'} */
        let outcome = 'missing';
        /** @type {XrefChainLoopResult | null} */
        let settled = null;
        try {
          const raced = await Promise.race([
            win.evaluate(() => { const w = /** @type {XrefPageWindow} */ (window); return w.__xrefChain ? w.__xrefChain.done : null; })
              .then((v) => ({ tag: 'value', v }), () => ({ tag: 'error', v: null })),
            new Promise((doneRace) => setTimeout(() => doneRace({ tag: 'timeout', v: null }), 60_000)),
          ]);
          if (raced.tag === 'timeout') outcome = 'timeout';
          else if (raced.tag === 'error') outcome = 'rejected';
          else if (raced.v) { outcome = 'resolved'; settled = raced.v; }
          else outcome = 'missing';
        } catch { outcome = 'rejected'; }
        /** @type {XrefChainLoopResult | null} */
        let fallbackCounters = null;
        if (outcome !== 'resolved') {
          try {
            fallbackCounters = await win.evaluate(() => {
              const c = /** @type {XrefPageWindow} */ (window).__xrefChain;
              return c ? { links: c.links, errors: c.errors, totalBytes: c.totalBytes, lastError: c.lastError } : null;
            });
          } catch { fallbackCounters = null; }
        }
        return chainCollectionDecisionImpl({ outcome, summary: settled, fallbackCounters });
      };
      let s1 = null;
      let s2 = null;
      let s3 = null;
      let readB = { ok: false };
      let chainSummary = null;
      try {
        // Step 1: start the renewal chain on context A (the evaluate
        // returns immediately; the chain runs in the page). The loop
        // is THIS FILE's xrefChainLoopImpl, installed from its own
        // serialized source and driven by the page's real bridge
        // read - the same function object --self-test-burst drives.
        await win.evaluate(XREF_CHAIN_LOOP_FN_SOURCE);
        await win.evaluate(([t, k, m, expectBytes, maxLinks, busyRetries]) => {
          const w = /** @type {XrefPageWindow} */ (window);
          const chain = {
            links: 0, errors: 0, totalBytes: 0, stopped: false, lastError: null, done: null,
            stop() { chain.stopped = true; },
          };
          chain.done = /** @type {XrefChainLoopFn} */ (w.__xrefChainLoop)(() => /** @type {XrefBridgeStub} */ (w.__xref).read(t, k, m), { maxLinks, busyRetries, expectBytes, state: chain });
          w.__xrefChain = chain;
        }, [ctxA.token, slow.ticket, 16 * MIB, slowBytes, CHAIN_MAX_LINKS, CHAIN_BUSY_RETRIES]);
        stepMark('renewal chain started on context A (unawaited)', null);
        // Step 2: sample S1 - the chain must already show as genuinely active.
        s1 = await sampleObserver(app, 'burst-s1-after-chain-start');
        stepMark('S1 sampled', s1);
        // Step 3: the same-context competing read must refuse BUSY
        // (zero queue), with bounded attempts: an attempt that lands
        // in an inter-link gap is ADMITTED and completes a real read
        // of the leaf - it is recorded in results.burstAttempts and
        // retried; the refusal counts when BUSY occurs within
        // CHAIN_REFUSAL_ATTEMPTS attempts.
        for (let i = 0; i < CHAIN_REFUSAL_ATTEMPTS; i += 1) {
          const r = await read(ctxA.token, leafA.ticket, MIB);
          attempts.push({ attempt: i + 1, ok: Boolean(r && r.ok), code: r && !r.ok ? (r.code ?? null) : null });
          stepMark(`competing read attempt ${i + 1} returned`, null);
          if (r && !r.ok && r.code === 'ERR_XREF_RESOURCE_BUSY') break;
        }
        // Step 4: sample S2 - the chain must STILL be active at the refusal.
        s2 = await sampleObserver(app, 'burst-s2-at-refusal');
        stepMark('S2 sampled (at refusal)', s2);
        // Step 5: context B identifies and reads to completion.
        const ctxB = await begin('native-3.3-b');
        const idB = ctxB.ok ? await identify(ctxB.token, fx(leafRel)) : { ok: false };
        readB = idB.ok ? await read(ctxB.token, idB.ticket, MIB) : { ok: false };
        stepMark('B read completed', null);
        if (ctxB.ok) await closeCtx(ctxB.token);
        // Step 6: sample S3 - the chain must STILL be active at B's completion.
        s3 = await sampleObserver(app, 'burst-s3-at-b-completion');
        stepMark('S3 sampled (at B completion)', s3);
      } finally {
        // The chain never outlives the burst: stop it and collect
        // its summary (bounded wait) before S4, whatever happened
        // above. 'Drained' is claimed ONLY when the collection
        // positively confirmed the drain (H2).
        chainSummary = await stopChainAndCollect();
        stepMark(chainSummary.drained ? 'renewal chain stopped and drained (drain positively confirmed)' : 'renewal chain stop requested; drain NOT positively confirmed (summary is diagnostic only)', null);
      }
      // Step 7: sample S4 (the burst's settle point; 'settled' is
      // claimed only on a positively confirmed drain).
      const s4 = await sampleObserver(app, 'burst-s4-after-a-settles');
      stepMark(chainSummary?.drained ? 'chain settled (S4 sampled)' : 'S4 sampled (chain drain unconfirmed)', s4);
      const busyAttempt = attempts.find((a) => !a.ok && a.code === 'ERR_XREF_RESOURCE_BUSY');
      check(Boolean(busyAttempt), 'second read in the same context refuses BUSY while A is in flight (zero queue)', JSON.stringify(attempts));
      check(readB && readB.ok, 'a read in a second context proceeds and completes while A is in flight', JSON.stringify(readB));
      check(chainSummary && chainSummary.drained === true && chainSummary.errors === 0 && chainSummary.links >= 1 && chainSummary.totalBytes === chainSummary.links * slowBytes,
        'every renewal-chain link returns the full file (per-link bytes verified in the page; total = links * slow size; drain positively confirmed)', JSON.stringify(chainSummary));
      {
        const overlapName = 'observer-bound overlap: A pending with its reservation (activeOps >= 1, reservedRawBytes = slow size + sentinel) at S1, at the BUSY refusal (S2) and at B completion (S3), one main clock/sequence';
        if (!observerMode) blocked(overlapName);
        else if (!observerUsable(mainObserver, s1) || !observerUsable(mainObserver, s2) || !observerUsable(mainObserver, s3)) {
          blocked(overlapName, observerBlockReason(mainObserver, s3 ?? s2 ?? s1));
        } else if (!mainObserver.correlation?.ok) {
          blocked(overlapName, correlationBlockReason(mainObserver));
        } else {
          const decision = burstWitnessDecisionImpl({ s1, s2, s3, chain: chainSummary, slowBytes, correlationOk: true, observerOk: true });
          if (decision.verdict === 'pass') {
            check(true, overlapName, `seq S1=${s1.seq} < S2=${s2.seq} < S3=${s3.seq} on the main monotonic clock; chain links=${chainSummary.links}, errors=0, totalBytes=${chainSummary.totalBytes}, drained=true; steps: ${burstSteps.map((m) => m.step).join(' -> ')}`);
          } else {
            blocked(overlapName, decision.reason);
          }
        }
      }
      await closeCtx(ctxA.token);
      await statsZeroCheck(app, mainObserver, 'broker stats return to baseline after the burst drains and context A closes (activeOps / reservedRawBytes zero; contexts / tickets / retiredActiveOps back to baseline)');
      // G1: the REAL loader + adapter, in the renderer, over this bridge.
      if (!bundleText) {
        blocked('real loader+adapter load (G1): the esbuild bundle of the accepted sources failed to build', bundleError ?? 'unknown bundle error');
      } else {
        await win.evaluate(bundleText);
        const injected = await win.evaluate(() => ['XrefStore', 'createXrefReader', 'collectXrefReferences', 'externalContent'].every((k) => typeof /** @type {XrefPageWindow} */ (window).__xrefCore?.[k] === 'function'));
        check(injected, 'accepted loader/adapter bundle injected into the renderer (window.__xrefCore)');
        // The semantic oracle ships from this file's own source (finding 1).
        await win.evaluate(SEMANTIC_ENTITY_FN_SOURCE);
        const semOk = await win.evaluate(() => typeof /** @type {XrefPageWindow} */ (window).__xrefSemanticEntityJson === 'function');
        check(semOk, 'semantic entity serializer injected into the renderer (window.__xrefSemanticEntityJson)');
        const out = await g1LoadInPage(win, 'native-g1');
        if (out.error) failHalt('real loader load threw in the renderer', out.error);
        else {
          const expectedRefs = [
            { blockName: 'CHILD', path: '../parts/child.dxf' },
            { blockName: 'LEAFWIN', path: '..\\shared\\leaf.dxf' },
            { blockName: 'OVLROOT', path: 'overlay-root.dxf', overlay: true },
          ];
          check(JSON.stringify(out.references) === JSON.stringify(expectedRefs), 'host references extracted from the LIVE opened drawing match the authored graph', JSON.stringify(out.references));
          check(out.load.committed && out.load.failures.length === 0, 'real XrefStore load commits with no failures', JSON.stringify(out.load.failures));
          const loadedPaths = (out.load.sig ?? []).map((e) => normPath(e.path));
          const wantLoaded = ['parts/child.dxf', 'shared/leaf.dxf', 'drawings/overlay-root.dxf', 'parts/grand.dxf', 'drawings/kid.dxf'];
          check(wantLoaded.every((w) => loadedPaths.some((p) => p.endsWith(w))), 'external content includes the nested graph (child, grand, leaf, overlay-root, kid)', loadedPaths.join(' | '));
          check(!loadedPaths.some((p) => p.endsWith('inner.dxf')), 'inner.dxf is NOT loaded (not referenced by this graph; nested-overlay witness stays unloaded)', loadedPaths.join(' | '));
          // Nonempty authored geometry (finding 1): loaded paths alone
          // are not enough - each node must carry exactly its authored
          // entity count (whole-file counts; every fixture's BLOCKS
          // section is empty, so these are the model entities).
          const expectedCounts = { 'parts/child.dxf': 2, 'parts/grand.dxf': 1, 'shared/leaf.dxf': 2, 'drawings/overlay-root.dxf': 2, 'drawings/kid.dxf': 1 };
          const countProblems = Object.entries(expectedCounts)
            .filter(([suffix, n]) => { const e = sigEntry(out.load.sig, suffix); return !e || e.entities.length !== n; })
            .map(([suffix, n]) => `${suffix}: expected ${n} entities, got ${sigEntry(out.load.sig, suffix)?.entities.length ?? 'node missing'}`);
          check(countProblems.length === 0, 'every loaded node carries its expected NONEMPTY authored geometry (exact entity counts per node)', countProblems.join(' | ') || 'child 2, grand 1, leaf 2, overlay-root 2, kid 1');
          check((out.load.nodes ?? []).every((n) => n.status === 'loaded'), 'every graph node reports status loaded', JSON.stringify(out.load.nodes));
          check(out.before.json !== null && out.after.json === out.before.json && out.after.dirty === out.before.dirty && out.after.revision === out.before.revision,
            'the load changed no app document state (snapshot bytes, dirty flag, revision identical)');
          check(sha256(readFileSync(hostPath)) === hostHashBefore, 'host file on disk unchanged by the load');
          if (out.load.committed) g1 = { sig: out.load.sig };
        }
      }
      if (sectionFailed(mark)) { halted = true; haltReason = 'stopped at the first failed PASS criterion in section 3.3'; }
    }
  }

  // -------------------------------------------------------------- 3.4
  if (sectionWanted('3.4')) {
    currentSection = '3.4';
    const mark = checks.length;
    if (halted) record('skipped', 'section 3.4 (refresh changed / no-op)', haltReason);
    else {
      const ctx = await begin('native-3.4');
      const leaf = await identify(ctx.token, fx(leafRel));
      const r1 = await read(ctx.token, leaf.ticket, MIB);
      const r2 = await read(ctx.token, leaf.ticket, MIB);
      check(r1.ok && r2.ok && r1.version === r2.version && typeof r1.text === 'string' && sha256(Buffer.from(r1.text, 'utf8')) === fixtureMeta.files[leafRel].sha256 && r1.text === r2.text,
        'unchanged xref reads back identically twice (same version, pinned content hash)', JSON.stringify({ v: r1.version }));
      await closeCtx(ctx.token);
      if (!g1) {
        blocked('real loader refresh after a valid edit (G1): no committed loader load exists in this run (section 3.3 did not produce one)');
      } else {
        const leafBefore = sigEntry(g1.sig, 'shared/leaf.dxf');
        const lineBefore = leafLine(leafBefore);
        check(Boolean(lineBefore) && lineBefore.b?.y === 0, 'leaf LINE endpoint starts at the authored value (b.y = 0)', JSON.stringify(lineBefore));
        let original = null;
        try {
          original = applyPinnedEdit(leafRel);
          const refreshed = await g1RefreshInPage(win);
          if (refreshed.error) failHalt('real loader refresh threw in the renderer', refreshed.error);
          else {
            check(refreshed.committed && refreshed.failures.length === 0, 'refresh after the pinned leaf edit commits with no failures', JSON.stringify(refreshed.failures));
            const leafAfter = sigEntry(refreshed.sig, 'shared/leaf.dxf');
            const lineAfter = leafLine(leafAfter);
            check(Boolean(lineAfter) && lineAfter.b?.y === 9 && lineAfter.b?.x === 10, 'the leaf node refreshed to the NEW content (LINE endpoint b.y = 9, the pinned edit)', JSON.stringify(lineAfter));
            check(Boolean(leafBefore) && Boolean(leafAfter) && leafAfter.version !== leafBefore.version, 'the leaf file version evidence changed on refresh', `${leafBefore?.version} -> ${leafAfter?.version}`);
            const others = (names) => (names ?? []).filter((e) => !normPath(e.path).endsWith('shared/leaf.dxf')).map((e) => JSON.stringify(e.entities)).join('~');
            check(others(refreshed.sig) === others(g1.sig), 'no other node changed on the leaf refresh (semantic entity comparison)');
            const again = await g1RefreshInPage(win);
            check(!again.error && again.committed && JSON.stringify(again.sig) === JSON.stringify(refreshed.sig),
              'a second refresh of the unchanged graph is a no-op (identical external content under the semantic oracle: re-parsed ids differ, content does not)');
            if (!again.error && again.sig) g1 = { sig: again.sig };
          }
        } finally {
          if (original) restoreFixture(leafRel, original);
        }
        await g1DisposeInPage(win);
      }
      if (sectionFailed(mark)) { halted = true; haltReason = 'stopped at the first failed PASS criterion in section 3.4'; }
    }
  }

  // -------------------------------------------------------------- 3.5
  if (sectionWanted('3.5')) {
    currentSection = '3.5';
    if (halted) record('skipped', 'section 3.5 (lifecycle)', haltReason);
    else {
      // 3.5a setup: the context must be bound to the HOST SESSION's
      // docId - the product's tab-close retire signal fires with that
      // exact docId, so a harness-label docId would never be retired.
      const hostSession = await win.evaluate((p) => {
        const s = window.editor.sessions;
        const i = s.indexOfPath(p);
        return i >= 0 ? { index: i, docId: s.list[i].docId, count: s.list.length } : null;
      }, hostPath);
      check(hostSession !== null && typeof hostSession.docId === 'string' && hostSession.docId !== '',
        'host session located for the lifecycle checks (its docId binds the 3.5 context)', JSON.stringify(hostSession));
      const ctx = hostSession ? await begin(hostSession.docId) : { ok: false };
      const leaf = await identify(ctx.token, fx(leafRel));
      check(leaf.ok, 'context for the lifecycle checks');
      // 3.5a: close the host tab, then try the old ticket (criterion as approved, unmodified).
      await win.evaluate((p) => {
        const s = window.editor.sessions;
        const i = s.indexOfPath(p);
        if (i >= 0) s.close(i);
      }, hostPath);
      await win.waitForTimeout(300);
      const tabState = await win.evaluate(() => {
        const s = window.editor.sessions;
        return {
          count: s.list.length,
          paths: s.list.map((x) => x.filePath ?? null),
          docIds: s.list.map((x) => x.docId),
          soleUntitled: s.list.length === 1 ? !s.list[0].filePath : false,
        };
      });
      check(hostSession !== null && tabRemovalDecisionImpl({ count: hostSession.count, hostDocId: hostSession.docId, hostPath }, tabState),
        'the host tab is actually removed before the read (host path and host docId absent from the sessions list)', JSON.stringify(tabState));
      const afterTab = await read(ctx.token, leaf.ticket, MIB);
      check(ctx.ok && leaf.ok && !afterTab.ok && afterTab.code === 'ERR_XREF_CONTEXT', 'read on a context whose host tab closed refuses CONTEXT (doc contexts retired on tab close)', JSON.stringify(afterTab));
      // 3.5a2: ADDITIONAL observation (not a substitute for 3.5a):
      // navigation retires the owner - the trigger the shipped wiring implements.
      await win.reload();
      await win.waitForFunction(() => !!window.editor, null, { timeout: 30_000 });
      await win.evaluate((p) => { /** @type {XrefPageWindow} */ (window).__xrefHostPath = p; }, hostPath);
      await installBridge(win);
      const afterNav = await win.evaluate(([t, k, m]) => /** @type {XrefPageWindow} */ (window).__xref.read(t, k, m), [ctx.token, leaf.ticket, MIB]);
      check(ctx.ok && leaf.ok && !afterNav.ok && afterNav.code === 'ERR_XREF_CONTEXT', 'additional observation: read after page navigation refuses CONTEXT (owner retired)', JSON.stringify(afterNav));
    }
  }
} catch (error) {
  if (!halted) failHalt(`harness error in section ${currentSection}`, String(error && error.message || error));
  else record('fail', `harness error in section ${currentSection}`, String(error && error.message || error));
} finally {
  try { await g1DisposeInPage(win); } catch { /* page may be gone */ }
  try { await closeBounded(app); } catch { /* bounded already */ }
}

// ------------------------------------------------------------ quit scenarios (Amendment 1)
// Lifecycle records: they run on fresh launches even when a behaviour
// section halted, provided the app itself launched. Clean exit is exit
// evidence only - NOT a completed-drain proof.
if (sections.includes('3.5')) {
  currentSection = '3.5-quit';
  for (const scenario of ['idle', 'after-limit']) {
    let qapp; let qwin;
    try {
      const qLaunch = await launchApp(`quit-${scenario}`);
      ({ app: qapp, win: qwin } = qLaunch);
      const qState = qLaunch.observer; // THIS launch's own coverage
      await openProjectAndHost(qapp, qwin);
      await qwin.evaluate((p) => { /** @type {XrefPageWindow} */ (window).__xrefHostPath = p; }, hostPath);
      await installBridge(qwin);
      // Same-broker correlation for THIS quit launch (round 3, group 2),
      // with its own short-lived context, before the scenario's own
      // context work: gates this launch's stats-derived checks.
      await runCorrelation(`quit-${scenario}`, qLaunch);
      const ctx = await qwin.evaluate(async () => {
        const b = await /** @type {XrefPageWindow} */ (window).__xref.begin('native-quit');
        if (b.ok) /** @type {XrefPageWindow} */ (window).__xrefToken = b.token;
        return b;
      });
      if (!ctx.ok) throw new Error(`begin failed: ${JSON.stringify(ctx)}`);
      if (scenario === 'after-limit') {
        const res = await qwin.evaluate(async (p) => {
          const idn = await /** @type {XrefPageWindow} */ (window).__xref.identify(/** @type {XrefPageWindow} */ (window).__xrefToken, p);
          if (!idn.ok) return idn;
          return /** @type {XrefPageWindow} */ (window).__xref.read(/** @type {XrefPageWindow} */ (window).__xrefToken, idn.ticket, 16 * 1024 * 1024);
        }, fx('oversized.dxf'));
        if (!(!res.ok && res.code === 'ERR_XREF_LIMIT')) throw new Error(`expected a LIMIT refusal before quitting, got ${JSON.stringify(res)}`);
        // Per-instance cleanup accounting (finding 2): LIMIT does not
        // close its context - close it explicitly, then this launch's
        // stats must return to THIS launch's own baseline.
        const closed = await qwin.evaluate(() => /** @type {XrefPageWindow} */ (window).__xref.close(/** @type {XrefPageWindow} */ (window).__xrefToken));
        if (!closed.ok) throw new Error(`explicit context close failed: ${JSON.stringify(closed)}`);
        const settleName = 'observer: after-limit launch returns to ITS OWN baseline after the explicit context close (activeOps / reservedRawBytes zero; contexts / tickets / retiredActiveOps at baseline)';
        const s = await sampleObserver(qapp, 'quit-after-limit-settled');
        if (!qState?.correlation?.ok) blocked(settleName, correlationBlockReason(qState));
        else if (!observerUsable(qState, s)) blocked(settleName, observerBlockReason(qState, s));
        else {
          const st = s.stats;
          const b = qState.baseline.stats;
          check(st.activeOps === 0 && st.reservedRawBytes === 0 && st.contexts === b.contexts && st.tickets === b.tickets && st.retiredActiveOps === b.retiredActiveOps,
            settleName, `sample=${JSON.stringify(st)} baseline=${JSON.stringify(b)}`);
        }
      } else if (observerMode) {
        // idle: the one-instance proof for THIS launch is its
        // same-broker correlation (round 3, group 2): usable stats
        // alone no longer suffice - the proof passes only when this
        // launch's correlation holds, on its own baseline/factory
        // evidence (begin observed at baseline+1, closed back).
        const proofName = 'observer same-broker correlation proof for the quit-idle launch (own zero baseline; real begin observed at contexts = baseline+1 with no active/reserved work; close returns contexts/tickets to baseline; factoryCalls === 1)';
        const s = await sampleObserver(qapp, 'quit-idle-pre-quit');
        if (!qState.correlation?.ok) blocked(proofName, correlationBlockReason(qState));
        else if (!observerUsable(qState, s)) blocked(proofName, observerBlockReason(qState, s));
        else check(true, proofName, `baseline seq=${qState.baseline.seq}, correlation seq ${qState.correlation.afterBeginSeq} -> ${qState.correlation.afterCloseSeq}, pre-quit seq=${s.seq}`);
      }
      const child = qapp.process();
      await qapp.evaluate(({ app: a }) => a.quit());
      const code = await waitForExit(child, 30_000);
      check(code === 0, `app quits cleanly from the ${scenario} state (process exit evidence only, not a drain proof)`, `exit code ${code}`);
    } catch (error) {
      check(false, `quit scenario ${scenario}`, String(error && error.message || error));
      try { await closeBounded(qapp); } catch { /* bounded already */ }
    }
  }
  // Inflight quit (Amendment 1): the witness is a main-side observer
  // sample taken in the SAME main callback that invokes the genuine
  // app.quit() - no intervening await, never a sleep. Without a valid
  // witness the criterion is BLOCKED (insufficient witness), not passed.
  const inflightName = 'app quits cleanly from the inflight state with a proven active read (sample+quit in one main callback; exit is exit evidence, not drain proof)';
  if (!observerMode) {
    blocked(inflightName);
  } else {
    let qapp; let qwin;
    try {
      const qLaunch = await launchApp('quit-inflight');
      ({ app: qapp, win: qwin } = qLaunch);
      const qState = qLaunch.observer; // THIS launch's own coverage
      await openProjectAndHost(qapp, qwin);
      await qwin.evaluate((p) => { /** @type {XrefPageWindow} */ (window).__xrefHostPath = p; }, hostPath);
      await installBridge(qwin);
      // Same-broker correlation for the inflight launch (round 3,
      // group 2), BEFORE the held read starts: if it fails, the
      // inflight criterion is BLOCKED regardless of the quit sample.
      await runCorrelation('quit-inflight', qLaunch);
      const started = await qwin.evaluate(async (p) => {
        const b = await /** @type {XrefPageWindow} */ (window).__xref.begin('native-quit-inflight');
        if (!b.ok) return b;
        /** @type {XrefPageWindow} */ (window).__xrefToken = b.token;
        const idn = await /** @type {XrefPageWindow} */ (window).__xref.identify(b.token, p);
        if (!idn.ok) return idn;
        /** @type {XrefPageWindow} */ (window).__xrefHeldRead = /** @type {XrefPageWindow} */ (window).__xref.read(b.token, idn.ticket, 16 * 1024 * 1024);
        return { ok: true };
      }, fx('slow.dxf'));
      if (!started.ok) throw new Error(`inflight setup failed: ${JSON.stringify(started)}`);
      const child = qapp.process();
      const sample = await qapp.evaluate(({ app: a }) => {
        const f = globalThis.__xrefTestObserver;
        const s = f ? f.sample() : null;
        a.quit();
        return s;
      });
      results.observerSamples.push({ tag: 'quit-inflight', sample });
      const code = await waitForExit(child, 30_000);
      const slowBytes = fixtureMeta.files['slow.dxf'].bytes;
      // The witness must satisfy THIS launch's own one-instance proof
      // and zero baseline (observerUsable against qState), not coverage
      // borrowed from any other app instance - AND this launch's
      // same-broker correlation (round 3, group 2): without it the
      // criterion is BLOCKED regardless of the quit sample.
      const witnessed = Boolean(observerUsable(qState, sample) && sample.stats.activeOps >= 1 && sample.stats.reservedRawBytes === slowBytes + 1);
      if (!qState.correlation?.ok) blocked(inflightName, correlationBlockReason(qState));
      else if (!witnessed) blocked(inflightName, `insufficient witness at quit initiation: ${JSON.stringify(sample)}`);
      else check(code === 0, inflightName, `exit code ${code}, sample=${JSON.stringify(sample.stats)} seq=${sample.seq}`);
    } catch (error) {
      check(false, 'quit scenario inflight', String(error && error.message || error));
      try { await closeBounded(qapp); } catch { /* bounded already */ }
    }
  }
}

clearTimeout(watchdog);
const failed = checks.filter((c) => c.status === 'fail');
const blockedCount = checks.filter((c) => c.status === 'blocked').length;
const passed = checks.filter((c) => c.status === 'pass').length;
log(`\nxref-refresh: ${passed} passed, ${failed.length} failed, ${blockedCount} blocked, ${checks.filter((c) => c.status === 'skipped').length} skipped (${checks.length} records)${failed.length ? ` - FAILURES: ${failed.map((f) => `[${f.section}] ${f.name}`).join('; ')}` : ''}`);
writeResults();
if (evidenceFailed) process.exit(3); // never 0 (or 1) without persisted evidence (finding 5)
process.exit(failed.length || blockedCount ? 1 : 0);
