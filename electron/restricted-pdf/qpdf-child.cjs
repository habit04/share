/**
 * One-shot qpdf transform child for the restricted PDF mode (milestone 12.4).
 *
 * Runs either as an Electron utilityProcess or as a plain child_process.fork
 * child (tests); the messaging adapter picks whichever parent channel exists.
 * Protocol: the parent sends exactly one message { input: Uint8Array }; the
 * child replies with exactly one message { output: Uint8Array } or
 * { error: string } and then exits. No other traffic, no filesystem access:
 * the PDF lives in the engine's MEMFS under the fixed virtual names below.
 *
 * The owner password is generated HERE from node:crypto and never leaves the
 * process: it is not logged, not returned, and not persisted. The user
 * password is empty by design (anyone may open the file; the /P flags below
 * are the requested editing restrictions). The argv is one fixed constant
 * apart from that password — no caller-controlled option can reach it.
 *
 * Fail-closed: ANY throw from module load or callMain — an Error, an
 * ExitStatus, or the raw number an uncaught C++ exception becomes across
 * this glue — is a job failure. So is a non-zero exit or a missing output.
 * MEMFS growth is budgeted BEFORE allocation (memfs-guard.cjs wraps the
 * glue's storage paths — expand/resize AND stream_ops.write, whose
 * adoption and empty-file fast paths allocate without expanding); the
 * output size limit is also re-checked from stat before readback, as a
 * backstop.
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
const { guardMemfsGrowth } = require('./memfs-guard.cjs');

const MAX_INPUT_BYTES = 128 * 1024 * 1024;
/** Output growth limit: stream inputs grow ~1 KB; object-rich inputs measured 1.53x (BOUNDS.md). */
const outputLimit = (inputBytes) => 2 * inputBytes + 1024 * 1024;
/**
 * MEMFS capacity budget for one job: input capacity (with one allocator
 * doubling of headroom) plus output capacity (the size cap with one
 * doubling). Mirrors the host's MEMFS stage reservations.
 */
const memfsBudget = (inputBytes) => 2 * inputBytes + 2 * outputLimit(inputBytes);
const ASSETS = path.join(__dirname, 'assets');

/** @param {string} ownerPassword */
function buildArgs(ownerPassword) {
  return [
    // General options precede --encrypt; stream data is preserved byte-for-byte.
    '--stream-data=preserve',
    '--encrypt',
    '--user-password=',
    `--owner-password=${ownerPassword}`,
    '--bits=256',
    // EncryptMetadata: qpdf's R6 default encrypts the metadata stream; there
    // is no --encrypt-metadata job option in 12.4.2 (passing one makes the
    // engine throw). The independent verifier asserts /EncryptMetadata true
    // on produced files instead of trusting this comment.
    // Permission profile P2: print (low+high), extract and accessibility
    // granted; modify, annotate, fill and assemble denied. /P = -1324.
    '--print=full',
    '--extract=y',
    '--accessibility=y',
    '--modify=none',
    '--annotate=n',
    '--form=n',
    '--assemble=n',
    '--',
    '/in.pdf',
    '/out.pdf',
  ];
}

/** @param {Uint8Array} input @returns {Promise<Uint8Array>} */
async function transform(input) {
  if (!(input instanceof Uint8Array) || input.byteLength < 8 || input.byteLength > MAX_INPUT_BYTES) throw new Error('Invalid PDF payload');
  if (Buffer.from(input.subarray(0, 5)).toString('latin1') !== '%PDF-') throw new Error('Invalid PDF payload');
  const factory = require(path.join(ASSETS, 'qpdf.js'));
  const wasmBinary = fs.readFileSync(path.join(ASSETS, 'qpdf.wasm'));
  /** @type {number | null} */
  let exitCode = null;
  const module = await factory({
    wasmBinary,
    print: () => {},
    printErr: () => {},
    onExit: (code) => { exitCode = code; },
  });
  // Stop MEMFS growth BEFORE the allocation that would exceed the budget:
  // wrap the glue's storage paths (expand/resize and stream_ops.write)
  // before any file is written. The factory's static init has already
  // snapshotted stream_ops.write into the MEMFS ops_table that file
  // nodes actually dispatch through, so the guard also repoints those
  // cached entries (round 3) — that is what covers the initial /in.pdf
  // write below and every output write. The guard throws (failing the
  // job closed) if the paths are not reachable.
  guardMemfsGrowth(module.FS && module.FS.filesystems && module.FS.filesystems.MEMFS, memfsBudget(input.byteLength));
  module.FS.writeFile('/in.pdf', input);
  const ownerPassword = randomBytes(32).toString('hex');
  /** @type {number | null} */
  let status = exitCode;
  try {
    const returned = module.callMain(buildArgs(ownerPassword));
    if (typeof returned === 'number') status = returned;
  } catch (error) {
    // ExitStatus carries .status; an uncaught engine exception arrives as a
    // raw number. Both are failures unless the status is exactly 0.
    if (error && typeof error.status === 'number') status = error.status;
    else if (typeof error === 'number') status = error;
    else throw new Error('The restricted PDF engine failed.');
  }
  if (status !== 0 && exitCode !== 0) throw new Error(`The restricted PDF engine refused the document (exit ${status ?? exitCode ?? 'unknown'}).`);
  let size;
  try { size = module.FS.stat('/out.pdf').size; } catch { throw new Error('The restricted PDF engine produced no output.'); }
  // Enforce the growth limit BEFORE readFile allocates the output copy.
  if (!Number.isInteger(size) || size < 8 || size > outputLimit(input.byteLength)) throw new Error('The restricted PDF output exceeds the size limit.');
  const output = module.FS.readFile('/out.pdf');
  if (!(output instanceof Uint8Array) || output.byteLength !== size) throw new Error('The restricted PDF engine output is incomplete.');
  if (Buffer.from(output.subarray(0, 8)).toString('latin1') !== '%PDF-1.7') throw new Error('The restricted PDF engine output is not a PDF 1.7 document.');
  return output;
}

// ---- parent channel: utilityProcess (process.parentPort) or fork IPC ----
const port = /** @type {any} */ (process).parentPort;
let replied = false;
function reply(message) {
  if (replied) return;
  replied = true;
  try {
    if (port) port.postMessage(message);
    else if (typeof process.send === 'function') process.send(message);
  } catch { /* The parent also treats a bare exit as failure. */ }
  // Give the message a tick to flush, then end the one-shot process.
  setTimeout(() => process.exit(message.error ? 1 : 0), 25).unref?.();
}
async function onMessage(message) {
  try {
    const input = message && message.input instanceof Uint8Array ? message.input : null;
    if (!input) throw new Error('Invalid PDF payload');
    const output = await transform(input);
    reply({ output });
  } catch (error) {
    reply({ error: error instanceof Error ? error.message : 'The restricted PDF engine failed.' });
  }
}
if (port) port.on('message', (event) => { void onMessage(event && event.data !== undefined ? event.data : event); });
else process.on('message', (message) => { void onMessage(message); });
// A child that never receives its one job must not linger.
setTimeout(() => { if (!replied) process.exit(2); }, 60_000).unref?.();
