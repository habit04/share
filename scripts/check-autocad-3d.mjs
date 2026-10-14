// Independent AutoCAD validation of JCad's 3D DXF output (docs/3D-AUTOCAD-VALIDATION.md).
//
//   npm run check:autocad:3d
//
// Windows with a licensed AutoCAD Core Console only (accoreconsole.exe; JCAD_AUTOCAD_CONSOLE or the
// first argument overrides the AutoCAD 2027 default path). For every input (the three committed 3D
// fixtures, a generated dimensions.dxf with DIM3D dimensions of known measurement in five planes plus
// one 2D dimension, and a copy of it whose stored measurements (group 42) are zeroed so AutoCAD must
// compute its own) the script:
//   1. opens the DXF in AutoCAD, runs AUDIT with Fix = Yes and records "errors found / fixed";
//   2. enumerates the model space with AutoLISP and writes JSON: every polyface POLYLINE (handle,
//      layer, colour, 71 / 72, VERTEX records by flag, SEQEND, XDATA), every DIMENSION (type,
//      text override, extrusion, definition points, XDATA), entity counts, EXTMIN / EXTMAX;
//   3. DXFOUTs it as R2018 and SAVEAS R2018 DWG; then forces AutoCAD to recompute every dimension
//      (entmod) and records AutoCAD's own measurement (group 42 after the recompute; the Core
//      Console has no ActiveX, so vla-get-Measurement is unavailable) and DXFOUTs that state too;
//      then removes every JCAD_3D XDATA and DXFOUTs again (what a program that drops it hands back);
//   4. opens the DWG in a second session (AUDIT, the same enumeration, DXFOUT);
//   5. compares in Node, against JCad's reader (`readDxf(text, { model3d: true })`) of the input and
//      of every AutoCAD-written DXF: polyface records and their counts, dimension measurements
//      (relative 1e-6), normals, definition points, the 2D dimension, solids / dimensions read back,
//      whether JCAD_3D XDATA (ids, histories, planes) survived, and every import-report item.
// A readable report goes to stdout and JSON to JCAD_AUTOCAD_3D_OUT (default: a file in the OS temp
// folder). Exit status 1 on any mismatch, AUDIT error, missing output or AutoCAD failure. The work
// folder (inputs, scripts, logs, AutoCAD output) is deleted after a pass and kept after a failure
// (or always with JCAD_AUTOCAD_3D_KEEP=1). XDATA loss is reported, not counted as a failure.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { nativeDxfRecords } from './check-autocad.mjs';

const RUN_TIMEOUT_MS = 240_000;
const MEASURE_TOLERANCE = 1e-6;
const FIXTURES = ['enclosure', 'cable-tray', 'schematic-with-solids'];

// ------------------------------------------------------------------ AutoLISP (one form per line)

/**
 * The enumeration is written as AutoLISP forms of one line each: the Core Console reads a script
 * line by line, a space or newline outside a LISP expression is Enter, and SECURELOAD refuses
 * `(load ...)` of a file outside the trusted folders, so the code is part of the script itself.
 * Every number is written as a JSON string of `rtos` mode 1 (scientific, 16 digits) so that no
 * DIMZIN / LUNITS setting can produce text JSON does not accept.
 */
const LISP = String.raw`
(vl-load-com)
(defun jc:e (s / r i c) (setq r "" i 1) (while (<= i (strlen s)) (setq c (substr s i 1)) (setq r (strcat r (cond ((= c "\\") "\\\\") ((= c "\"") "\\\"") ((< (ascii c) 32) " ") (t c)))) (setq i (1+ i))) r)
(defun jc:s (s) (if (= (type s) 'STR) (strcat "\"" (jc:e s) "\"") "null"))
(defun jc:n (x) (if (numberp x) (strcat "\"" (rtos x 1 16) "\"") "null"))
(defun jc:i (x) (if (numberp x) (itoa (fix x)) "null"))
(defun jc:p (p) (if p (strcat "[" (jc:n (car p)) "," (jc:n (cadr p)) "," (jc:n (if (caddr p) (caddr p) 0.0)) "]") "null"))
(defun jc:join (l sep / r f) (setq r "" f t) (foreach x l (setq r (if f x (strcat r sep x)) f nil)) r)
(defun jc:g (c ed) (cdr (assoc c ed)))
(defun jc:bump (k l) (if (assoc k l) (subst (cons k (1+ (cdr (assoc k l)))) (assoc k l) l) (cons (cons k 1) l)))
(defun jc:kv (l q) (strcat "{" (jc:join (mapcar '(lambda (a) (strcat "\"" (if q (car a) (itoa (car a))) "\":" (itoa (cdr a)))) l) ",") "}"))
(defun jc:strlens (gs / n) (setq n 0) (foreach g gs (if (= (type (cdr g)) 'STR) (setq n (+ n (strlen (cdr g)))))) n)
(defun jc:xd (e) (strcat "[" (jc:join (mapcar '(lambda (a) (strcat "{\"app\":" (jc:s (car a)) ",\"groups\":" (itoa (length (cdr a))) ",\"chars\":" (itoa (jc:strlens (cdr a))) "}")) (cdr (assoc -3 (entget e '("*"))))) ",") "]"))
(defun jc:neg (sd / n) (setq n 0) (foreach c '(71 72 73 74) (if (and (jc:g c sd) (< (jc:g c sd) 0)) (setq n (1+ n)))) n)
(defun jc:pf (e ed / sub sd kinds fl quads neg seq) (setq sub (entnext e) kinds nil quads 0 neg 0) (while (and sub (= "VERTEX" (jc:g 0 (setq sd (entget sub))))) (setq fl (jc:g 70 sd) kinds (jc:bump fl kinds)) (if (= fl 128) (progn (if (and (jc:g 74 sd) (/= 0 (jc:g 74 sd))) (setq quads (1+ quads))) (setq neg (+ neg (jc:neg sd))))) (setq sub (entnext sub))) (setq seq (and sub (= "SEQEND" (jc:g 0 (entget sub))))) (strcat "{\"handle\":" (jc:s (jc:g 5 ed)) ",\"layer\":" (jc:s (jc:g 8 ed)) ",\"color\":" (jc:i (if (jc:g 62 ed) (jc:g 62 ed) 256)) ",\"trueColor\":" (jc:i (jc:g 420 ed)) ",\"flags\":" (jc:i (jc:g 70 ed)) ",\"m\":" (jc:i (jc:g 71 ed)) ",\"n\":" (jc:i (jc:g 72 ed)) ",\"vertexKinds\":" (jc:kv kinds nil) ",\"quadFaces\":" (itoa quads) ",\"negativeIndices\":" (itoa neg) ",\"seqend\":" (if seq "true" "false") ",\"xdata\":" (jc:xd e) "}"))
(defun jc:dim (e ed) (strcat "{\"handle\":" (jc:s (jc:g 5 ed)) ",\"layer\":" (jc:s (jc:g 8 ed)) ",\"color\":" (jc:i (if (jc:g 62 ed) (jc:g 62 ed) 256)) ",\"flags\":" (jc:i (jc:g 70 ed)) ",\"type\":" (jc:i (logand (jc:g 70 ed) 7)) ",\"block\":" (jc:s (jc:g 2 ed)) ",\"style\":" (jc:s (jc:g 3 ed)) ",\"text\":" (jc:s (jc:g 1 ed)) ",\"measurement\":" (jc:n (jc:g 42 ed)) ",\"rotation\":" (jc:n (jc:g 50 ed)) ",\"normal\":" (jc:p (if (jc:g 210 ed) (jc:g 210 ed) '(0.0 0.0 1.0))) ",\"p10\":" (jc:p (jc:g 10 ed)) ",\"p11\":" (jc:p (jc:g 11 ed)) ",\"p13\":" (jc:p (jc:g 13 ed)) ",\"p14\":" (jc:p (jc:g 14 ed)) ",\"p15\":" (jc:p (jc:g 15 ed)) ",\"p16\":" (jc:p (jc:g 16 ed)) ",\"xdata\":" (jc:xd e) "}"))
(defun jc:report (path stage / f ss i e ed typ counts pfs dims emin emax) (setq ss (ssget "_X" '((410 . "Model"))) i 0 counts nil pfs nil dims nil) (if ss (repeat (sslength ss) (setq e (ssname ss i) i (1+ i) ed (entget e) typ (jc:g 0 ed) counts (jc:bump typ counts)) (if (and (= typ "POLYLINE") (= 64 (logand 64 (jc:g 70 ed)))) (setq pfs (cons (jc:pf e ed) pfs))) (if (= typ "DIMENSION") (setq dims (cons (jc:dim e ed) dims))))) (setq emin (getvar "EXTMIN") emax (getvar "EXTMAX")) (command "_.ZOOM" "_E") (setq f (open path "w")) (write-line (strcat "{\"stage\":" (jc:s stage) ",\"acadver\":" (jc:s (getvar "ACADVER")) ",\"dwgname\":" (jc:s (getvar "DWGNAME")) ",\"headerExtmin\":" (jc:p emin) ",\"headerExtmax\":" (jc:p emax) ",\"extmin\":" (jc:p (getvar "EXTMIN")) ",\"extmax\":" (jc:p (getvar "EXTMAX")) ",\"counts\":" (jc:kv counts t) ",") f) (write-line "\"polyfaces\":[" f) (setq i 0) (foreach x (reverse pfs) (write-line (strcat (if (= i 0) "" ",") x) f) (setq i (1+ i))) (write-line "],\"dimensions\":[" f) (setq i 0) (foreach x (reverse dims) (write-line (strcat (if (= i 0) "" ",") x) f) (setq i (1+ i))) (write-line "]}" f) (close f) (princ (strcat "JCAD3D_REPORT_WRITTEN " stage)) (princ))
(defun jc:strip (/ ss i e n) (setq ss (ssget "_X" '((410 . "Model") (-3 ("JCAD_3D")))) i 0 n 0) (if ss (repeat (sslength ss) (setq e (ssname ss i) i (1+ i)) (if (entmod (list (cons -1 e) (list -3 (list "JCAD_3D")))) (setq n (1+ n))))) (princ (strcat "JCAD3D_STRIPPED " (itoa n))) (princ))
(defun jc:recompute (/ ss i e) (setq ss (ssget "_X" '((0 . "DIMENSION") (410 . "Model"))) i 0) (if ss (repeat (sslength ss) (setq e (ssname ss i) i (1+ i)) (entmod (entget e)) (entupd e))) (princ (strcat "JCAD3D_RECOMPUTED " (itoa (if ss (sslength ss) 0)))) (princ))
`.trim().split('\n');

const lispPath = (file) => JSON.stringify(file.replaceAll('\\', '/'));
// Assembled at run time, so the console's echo of the script line itself never contains the marker.
const step = (name) => `(princ (strcat "JCAD3D_" "STEP ${name}"))`;

/** Session 1: open the JCad DXF, audit, report, DXFOUT, SAVEAS DWG, recompute the dimensions, report, DXFOUT. */
function sessionScript(dir) {
  return [
    '(setvar "FILEDIA" 0)', '(setvar "CMDDIA" 0)', step('start'),
    '_.AUDIT', '_Yes', step('audit'),
    ...LISP, step('lisp'),
    `(jc:report ${lispPath(join(dir, 'report-loaded.json'))} "loaded")`,
    `(command "_.DXFOUT" ${lispPath(join(dir, 'autocad-r2018.dxf'))} "_Version" "2018" "16")`, step('dxfout'),
    `(command "_.SAVEAS" "2018" ${lispPath(join(dir, 'autocad-r2018.dwg'))})`, step('saveas'),
    '(jc:recompute)',
    `(jc:report ${lispPath(join(dir, 'report-recomputed.json'))} "recomputed")`,
    `(command "_.DXFOUT" ${lispPath(join(dir, 'autocad-recomputed-r2018.dxf'))} "_Version" "2018" "16")`, step('dxfout-recomputed'),
    // Simulation of a program that drops JCad's data: AutoCAD itself removes JCAD_3D, then DXFOUT.
    '(jc:strip)',
    `(jc:report ${lispPath(join(dir, 'report-stripped.json'))} "stripped")`,
    `(command "_.DXFOUT" ${lispPath(join(dir, 'autocad-stripped-r2018.dxf'))} "_Version" "2018" "16")`, step('dxfout-stripped'),
    step('complete'), '_.QUIT', '_Yes', '',
  ].join('\r\n');
}

/** Session 2: open the DWG AutoCAD saved, audit, report, DXFOUT. */
function dwgScript(dir) {
  return [
    '(setvar "FILEDIA" 0)', '(setvar "CMDDIA" 0)', step('start'),
    '_.AUDIT', '_Yes', step('audit'),
    ...LISP, step('lisp'),
    `(jc:report ${lispPath(join(dir, 'report-dwg.json'))} "dwg")`,
    `(command "_.DXFOUT" ${lispPath(join(dir, 'autocad-dwg-r2018.dxf'))} "_Version" "2018" "16")`, step('dxfout'),
    step('complete'), '_.QUIT', '_Yes', '',
  ].join('\r\n');
}

/** Run the Core Console on `drawing` with `script`, bounded in time and output; never throws for AutoCAD's own failures. */
function runConsole(executable, drawing, script, dir, label) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(executable, ['/i', drawing, '/s', script, '/l', 'en-US', '/isolate', `jcad-3d-validation-${label}`, join(dir, `profile-${label}`)], { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let size = 0, timedOut = false, overflow = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, RUN_TIMEOUT_MS);
    const collect = (chunk) => { size += chunk.length; if (size <= 16 * 1024 * 1024) chunks.push(chunk); else { overflow = true; child.kill(); } };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const finish = (exitCode, error) => {
      clearTimeout(timer);
      const bytes = Buffer.concat(chunks);
      // The Core Console writes UTF-16LE when its output is redirected.
      const log = (bytes.includes(0) ? bytes.toString('utf16le') : bytes.toString('utf8')).replaceAll('\0', '');
      writeFileSync(join(dir, `${label}.log`), log);
      const audit = [...log.matchAll(/Total errors found\s+(\d+)\s+fixed\s+(\d+)/gi)].map((m) => ({ found: Number(m[1]), fixed: Number(m[2]) }));
      done({
        label, exitCode, error: error?.message ?? null, timedOut, overflow, seconds: Math.round((Date.now() - started) / 100) / 10,
        steps: [...new Set([...log.matchAll(/JCAD3D_STEP ([\w-]+)/g)].map((m) => m[1]))],
        audit: audit.length === 1 ? audit[0] : null, auditMatches: audit.length,
        rejected: /Invalid or incomplete DXF|drawing discarded|error in drawing file|Cannot find the specified drawing/i.test(log),
        lispErrors: [...log.matchAll(/; error: ([^\r\n]*)/g)].map((m) => m[1]),
        warnings: [...new Set([...log.matchAll(/^(Unknown header variable[^\r\n]*|[^\r\n]*(?:invalid|not valid|ignored|unable|could not)[^\r\n]*)$/gim)].map((m) => m[1].trim()))].slice(0, 50),
      });
    };
    child.once('error', (error) => finish(null, error));
    child.once('close', (exitCode) => finish(exitCode, null));
  });
}

// ------------------------------------------------------------------ JCad's DXF, read natively

/** Model-space polyfaces, DIMENSIONs and entity counts of a DXF, by handle (independent of JCad's reader). */
function nativeInventory(text) {
  const records = nativeDxfRecords(text);
  const field = (r, code) => r.groups.find(([c]) => c === code)?.[1];
  const num = (r, code, fallback = undefined) => { const v = field(r, code); return v === undefined ? fallback : Number(v); };
  const pt = (r, code) => field(r, code) === undefined ? null : [num(r, code), num(r, code + 10, 0), num(r, code + 20, 0)];
  const acadver = /\$ACADVER\r?\n\s*1\r?\n([^\r\n]*)/.exec(text)?.[1]?.trim() ?? null;
  const polyfaces = [], dimensions = [], counts = {};
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.section !== 'ENTITIES' || ['SECTION', 'ENDSEC', 'VERTEX', 'SEQEND', 'ATTRIB'].includes(r.kind)) continue;
    if (num(r, 67, 0) === 1) continue; // paper space
    counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    const xdataApps = r.groups.filter(([c]) => c === 1001).map(([, v]) => v);
    if (r.kind === 'POLYLINE' && (num(r, 70, 0) & 64)) {
      const vertexKinds = {}; let j = i + 1;
      while (records[j]?.kind === 'VERTEX') { const f = num(records[j], 70, 0); vertexKinds[f] = (vertexKinds[f] ?? 0) + 1; j++; }
      polyfaces.push({ handle: field(r, 5), layer: field(r, 8), color: num(r, 62, 256), m: num(r, 71), n: num(r, 72), vertexKinds, seqend: records[j]?.kind === 'SEQEND', xdataApps });
    }
    if (r.kind === 'DIMENSION') {
      dimensions.push({ handle: field(r, 5), layer: field(r, 8), color: num(r, 62, 256), flags: num(r, 70), type: num(r, 70) & 7, block: field(r, 2), text: field(r, 1) ?? null, measurement: num(r, 42, null), normal: pt(r, 210) ?? [0, 0, 1], p10: pt(r, 10), p11: pt(r, 11), p13: pt(r, 13), p14: pt(r, 14), p15: pt(r, 15), p16: pt(r, 16), jcad3d: xdataApps.includes('JCAD_3D'), xdataApps });
    }
  }
  return { acadver, polyfaces, dimensions, counts };
}

/** AutoCAD's JSON report, numbers given as strings, parsed. */
function readReport(file) {
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, 'latin1'));
  const nums = (v) => Array.isArray(v) ? v.map(nums) : typeof v === 'string' && /^-?\d*\.?\d+(E[+-]\d+)?$/i.test(v) ? Number(v) : v;
  for (const key of ['headerExtmin', 'headerExtmax', 'extmin', 'extmax']) raw[key] = nums(raw[key]);
  for (const d of raw.dimensions) for (const key of ['measurement', 'rotation', 'normal', 'p10', 'p11', 'p13', 'p14', 'p15', 'p16']) d[key] = d[key] === null ? null : nums(d[key]);
  return raw;
}

// ------------------------------------------------------------------ comparison helpers

const relDiff = (a, b) => Math.abs(a - b) / Math.max(1e-12, Math.abs(a), Math.abs(b));
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
const nearVec = (a, b, tol = 1e-9) => !!a && !!b && a.length === b.length && a.every((v, i) => near(v, b[i], tol));
const fmt = (v) => typeof v === 'number' ? Number(v.toPrecision(12)).toString() : Array.isArray(v) ? `(${v.map(fmt).join(', ')})` : String(v);

const sub3 = (a, b) => a.map((v, i) => v - b[i]);
const dot3 = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len3 = (a) => Math.sqrt(dot3(a, a));
/** Counter-clockwise angle from u to v seen from the normal side, in [0, 2 pi). */
const ccw = (u, v, normal) => { const a = Math.atan2(dot3(cross3(u, v), normal), dot3(u, v)); return a < 0 ? a + 2 * Math.PI : a; };

/**
 * Group 10 of a three-point angular dimension is a point on the dimension arc. Only its distance
 * from the vertex (15) and the side it is on carry meaning, so AutoCAD may move it along the arc:
 * compare the radius, the plane and that it lies inside the measured sweep (13 -> 14,
 * counter-clockwise about the extrusion), and report where on the sweep each program puts it.
 */
function arcPoint(actual, native) {
  const u = sub3(native.p13, native.p15), w = sub3(native.p14, native.p15);
  const qa = sub3(actual.p10, native.p15), qn = sub3(native.p10, native.p15);
  const sweep = ccw(u, w, native.normal);
  return {
    radius: near(len3(qa), len3(qn), 1e-9), plane: Math.abs(dot3(qa, native.normal)) <= 1e-9 * Math.max(1, len3(qn)),
    inside: ccw(u, qa, native.normal) <= sweep + 1e-12, fractionAutocad: ccw(u, qa, native.normal) / sweep, fractionJcad: ccw(u, qn, native.normal) / sweep,
  };
}

function checkArcPoint(c, label, actual, native) {
  const arc = arcPoint(actual, native);
  c.check(arc.radius && arc.plane && arc.inside, `${label}: angular arc point (group 10) ${fmt(actual.p10)} is not on JCad's arc (radius ${arc.radius}, in plane ${arc.plane}, inside the sweep ${arc.inside})`);
  if (!nearVec(actual.p10, native.p10, 1e-9)) c.note(`${label}: AutoCAD moved the angular arc point (group 10) along the arc from ${fmt(arc.fractionJcad)} to ${fmt(arc.fractionAutocad)} of the sweep (radius and side kept): ${fmt(native.p10)} -> ${fmt(actual.p10)}`);
}

function makeChecker() {
  const failures = [], notes = [];
  return {
    failures, notes,
    check(ok, message) { if (!ok) failures.push(message); return ok; },
    note(message) { notes.push(message); },
  };
}

/** AutoCAD's view of the loaded drawing against what JCad wrote (native records) and what JCad's reader holds. */
function compareLoaded(c, where, report, native, expected, known) {
  if (!c.check(!!report, `${where}: AutoCAD wrote no entity report`)) return {};
  // Polyfaces.
  const pfByHandle = new Map(report.polyfaces.map((p) => [p.handle, p]));
  c.check(report.polyfaces.length === native.polyfaces.length, `${where}: AutoCAD has ${report.polyfaces.length} polyface meshes, JCad wrote ${native.polyfaces.length}`);
  c.check(native.polyfaces.length === expected.solids.length, `${where}: JCad wrote ${native.polyfaces.length} polyface records for ${expected.solids.length} solids (a split mesh is not expected in these inputs)`);
  let handlesKept = 0, pfMatched = 0, pfXdata = 0;
  native.polyfaces.forEach((n, k) => {
    const solid = expected.solids[k];
    const a = pfByHandle.get(n.handle) ?? report.polyfaces[k];
    if (pfByHandle.has(n.handle)) handlesKept++;
    if (!c.check(!!a, `${where}: polyface ${n.handle} missing in AutoCAD`)) return;
    const label = `${where}: polyface ${n.handle}${solid ? ` (${solid.id})` : ''}`;
    let ok = true;
    ok = c.check(a.flags & 64, `${label}: flag 64 lost (70 = ${a.flags})`) && ok;
    ok = c.check(a.layer === n.layer, `${label}: layer ${a.layer} != ${n.layer}`) && ok;
    ok = c.check(a.color === n.color, `${label}: colour ${a.color} != ${n.color}`) && ok;
    ok = c.check(a.m === n.m && a.n === n.n, `${label}: 71/72 = ${a.m}/${a.n}, JCad wrote ${n.m}/${n.n}`) && ok;
    if (solid) ok = c.check(a.m === solid.vertices && a.n === solid.faces, `${label}: 71/72 = ${a.m}/${a.n}, the solid has ${solid.vertices} vertices / ${solid.faces} triangles`) && ok;
    const kinds = Object.keys(a.vertexKinds).sort().join(',');
    ok = c.check(kinds === '128,192' || kinds === '192' && a.n === 0, `${label}: VERTEX kinds ${JSON.stringify(a.vertexKinds)} (expected 192 and 128 only)`) && ok;
    ok = c.check(a.vertexKinds[192] === n.m && a.vertexKinds[128] === n.n, `${label}: VERTEX records ${JSON.stringify(a.vertexKinds)} vs 71/72 ${n.m}/${n.n}`) && ok;
    ok = c.check(a.quadFaces === 0 && a.negativeIndices === 0, `${label}: AutoCAD shows ${a.quadFaces} four-sided faces / ${a.negativeIndices} invisible-edge indices (JCad writes triangles, all edges visible)`) && ok;
    ok = c.check(a.seqend, `${label}: no SEQEND in AutoCAD`) && ok;
    if (a.xdata.some((x) => x.app === 'JCAD_3D')) pfXdata++;
    if (ok) pfMatched++;
  });
  // Dimensions.
  const dimByHandle = new Map(report.dimensions.map((d) => [d.handle, d]));
  c.check(report.dimensions.length === native.dimensions.length, `${where}: AutoCAD has ${report.dimensions.length} dimensions, JCad wrote ${native.dimensions.length}`);
  const native3d = native.dimensions.filter((d) => d.jcad3d), native2d = native.dimensions.filter((d) => !d.jcad3d);
  c.check(native3d.length === expected.dims3d.length && native2d.length === expected.dims2d.length, `${where}: JCad's DXF has ${native3d.length} 3D / ${native2d.length} 2D DIMENSIONs, its reader ${expected.dims3d.length} / ${expected.dims2d.length}`);
  let dimXdata = 0;
  const dims = [];
  const compareDim = (n, jc, is3d) => {
    const a = dimByHandle.get(n.handle);
    const label = `${where}: DIMENSION ${n.handle}${jc ? ` (${jc.id})` : ''}`;
    if (!c.check(!!a, `${label}: missing in AutoCAD`)) return;
    if (a.xdata.some((x) => x.app === 'JCAD_3D')) dimXdata++;
    c.check(a.type === n.type, `${label}: type ${a.type} != JCad ${n.type}`);
    c.check(nearVec(a.normal, n.normal, 1e-12), `${label}: extrusion ${fmt(a.normal)} != JCad ${fmt(n.normal)}`);
    if (jc && is3d) c.check(nearVec(a.normal, jc.normal, 1e-9), `${label}: extrusion ${fmt(a.normal)} != plane normal ${fmt(jc.normal)}`);
    for (const key of ['p10', 'p11', 'p13', 'p14', 'p15', 'p16']) {
      if (n[key] === null && a[key] === null) continue;
      // AutoCAD always has 15 / 16 (zero when unused); compare only what JCad wrote.
      if (n[key] === null) continue;
      if (key === 'p10' && n.type === 5) { checkArcPoint(c, label, a, n); continue; }
      c.check(nearVec(a[key], n[key], 1e-9), `${label}: group ${key.slice(1)} ${fmt(a[key])} != JCad ${fmt(n[key])}`);
    }
    c.check((a.text ?? '') === (n.text ?? ''), `${label}: text override ${JSON.stringify(a.text)} != JCad ${JSON.stringify(n.text)}`);
    if (jc) c.check((a.text ?? '') === (jc.textOverride ?? ''), `${label}: text override ${JSON.stringify(a.text)} != JCad's ${JSON.stringify(jc.textOverride)}`);
    dims.push({ handle: n.handle, id: jc?.id ?? null, is3d, kind: jc?.kind ?? null, jcadMeasurement: jc?.measurement ?? null, known: known?.get(jc?.id) ?? (is3d ? undefined : known?.get('dim-2d')) ?? null, storedByJcad: n.measurement, loadedByAutocad: a.measurement, normal: a.normal, text: a.text });
  };
  native3d.forEach((n, k) => compareDim(n, expected.dims3d[k], true));
  native2d.forEach((n, k) => compareDim(n, expected.dims2d[k], false));
  // Entity counts (model space, main entities).
  const typesA = Object.keys(report.counts).sort(), typesN = Object.keys(native.counts).sort();
  c.check(JSON.stringify(typesA) === JSON.stringify(typesN) && typesA.every((t) => report.counts[t] === native.counts[t]), `${where}: model-space entity counts ${JSON.stringify(report.counts)} != JCad's ${JSON.stringify(native.counts)}`);
  // Extents contain the solids.
  if (expected.bounds) {
    const pad = (v) => 1e-6 * Math.max(1, Math.abs(v));
    const inside = [0, 1, 2].every((i) => report.extmin[i] <= expected.bounds.min[i] + pad(expected.bounds.min[i]) && report.extmax[i] >= expected.bounds.max[i] - pad(expected.bounds.max[i]));
    c.check(inside, `${where}: AutoCAD extents ${fmt(report.extmin)}-${fmt(report.extmax)} do not contain the solids' bounds ${fmt(expected.bounds.min)}-${fmt(expected.bounds.max)}`);
  }
  return { polyfaces: report.polyfaces.length, polyfacesMatched: pfMatched, handlesKept, polyfaceXdata: pfXdata, dimensions: report.dimensions.length, dimensionXdata: dimXdata, dims, counts: report.counts, extmin: report.extmin, extmax: report.extmax, headerExtmin: report.headerExtmin, headerExtmax: report.headerExtmax, acadver: report.acadver };
}

/** AutoCAD's recomputed measurement of every dimension against JCad's value and the analytic one. */
function compareMeasurements(c, where, loaded, recomputed, native) {
  if (!c.check(!!recomputed, `${where}: AutoCAD wrote no report after recomputing the dimensions`)) return [];
  const byHandle = new Map(recomputed.dimensions.map((d) => [d.handle, d]));
  return (loaded.dims ?? []).map((d) => {
    const r = byHandle.get(d.handle);
    const label = `${where}: DIMENSION ${d.handle} (${d.id})`;
    if (!c.check(!!r, `${label}: missing after the recompute`)) return d;
    const autocad = r.measurement;
    c.check(typeof autocad === 'number' && relDiff(autocad, d.jcadMeasurement) <= MEASURE_TOLERANCE, `${label}: AutoCAD measures ${fmt(autocad)}, JCad ${fmt(d.jcadMeasurement)} (relative difference ${fmt(relDiff(autocad, d.jcadMeasurement))})`);
    if (d.known !== null) c.check(relDiff(autocad, d.known) <= MEASURE_TOLERANCE, `${label}: AutoCAD measures ${fmt(autocad)}, the analytic value is ${fmt(d.known)}`);
    // The recompute must not move the definition points JCad wrote.
    const n = native.dimensions.find((x) => x.handle === d.handle);
    for (const key of ['p10', 'p13', 'p14', 'p15']) if (key === 'p10' && n?.type === 5) checkArcPoint({ check: c.check, note: (_message) => {} }, `${label} after the recompute`, r, n);
    else if (n?.[key]) c.check(nearVec(r[key], n[key], 1e-9), `${label}: the recompute moved group ${key.slice(1)} to ${fmt(r[key])} (JCad ${fmt(n[key])})`);
    c.check(nearVec(r.normal, d.normal, 1e-12), `${label}: the recompute changed the extrusion to ${fmt(r.normal)}`);
    return { ...d, autocadMeasurement: autocad, relativeDifference: relDiff(autocad, d.jcadMeasurement), recomputedBlock: r.block };
  });
}

/** JCad's reading of an AutoCAD-written DXF against its reading of the input. */
function compareRoundTrip(c, where, expected, back, acadver) {
  if (!c.check(!!back, `${where}: no AutoCAD DXF to read back`)) return null;
  if ('error' in back) { c.check(false, `${where}: JCad cannot read the AutoCAD DXF: ${back.error}`); return { error: back.error }; }
  c.check(acadver === 'AC1032', `${where}: AutoCAD wrote ${acadver}, not R2018 (AC1032)`);
  const out = { acadver, solids: back.solids.length, dims3d: back.dims3d.length, dims2d: back.dims2d.length, idsKept: 0, historiesKept: 0, namesKept: 0, dimIdsKept: 0, planesKept: 0, geometryMatched: 0, reportItems: back.report?.items ?? [], reportNotes: back.report?.notes ?? [], reportCounts: back.report?.counts ?? {} };
  c.check(back.solids.length === expected.solids.length, `${where}: ${back.solids.length} solids read back, ${expected.solids.length} written`);
  const byId = new Map(back.solids.map((s) => [s.id, s]));
  expected.solids.forEach((s, k) => {
    const b = byId.get(s.id) ?? back.solids[k];
    const label = `${where}: solid ${s.id}`;
    if (!c.check(!!b, `${label}: not read back`)) return;
    if (b.id === s.id) out.idsKept++;
    if (b.feature === s.feature) out.historiesKept++;
    if (b.name === s.name) out.namesKept++;
    c.check(b.vertices === s.vertices && b.faces === s.faces, `${label}: ${b.vertices} vertices / ${b.faces} faces read back, ${s.vertices} / ${s.faces} written`);
    c.check(b.layer === s.layer && b.color === s.color, `${label}: layer/colour ${b.layer}/${b.color} read back, ${s.layer}/${s.color} written`);
    const geometry = b.indices.length === s.indices.length && b.indices.every((v, i) => v === s.indices[i]) && b.positions.length === s.positions.length && b.positions.every((v, i) => near(v, s.positions[i], 1e-12));
    if (c.check(geometry, `${label}: triangle indices or vertex coordinates changed`)) out.geometryMatched++;
  });
  c.check(back.dims3d.length === expected.dims3d.length, `${where}: ${back.dims3d.length} 3D dimensions read back, ${expected.dims3d.length} written`);
  const dimById = new Map(back.dims3d.map((d) => [d.id, d]));
  expected.dims3d.forEach((d, k) => {
    const b = dimById.get(d.id) ?? back.dims3d[k];
    const label = `${where}: 3D dimension ${d.id}`;
    if (!c.check(!!b, `${label}: not read back as a 3D dimension`)) return;
    if (b.id === d.id) out.dimIdsKept++;
    if (nearVec(b.origin, d.origin, 1e-12) && nearVec(b.xAxis, d.xAxis, 1e-12)) out.planesKept++;
    c.check(b.kind === d.kind && b.axis === d.axis, `${label}: read back as ${b.kind}/${b.axis}, written ${d.kind}/${d.axis}`);
    c.check(relDiff(b.measurement, d.measurement) <= MEASURE_TOLERANCE, `${label}: measurement ${fmt(b.measurement)} read back, ${fmt(d.measurement)} written`);
    c.check(nearVec(b.normal, d.normal, 1e-9), `${label}: plane normal ${fmt(b.normal)} read back, ${fmt(d.normal)} written`);
    c.check(near(b.elevation, d.elevation, 1e-9), `${label}: plane elevation ${fmt(b.elevation)} read back, ${fmt(d.elevation)} written`);
    c.check(b.text === d.text, `${label}: text ${JSON.stringify(b.text)} read back, ${JSON.stringify(d.text)} written`);
    c.check(b.projected === d.projected, `${label}: projected ${b.projected} read back, ${d.projected} written`);
    for (const key of ['p1', 'p2', 'vertex']) if (d[key]) c.check(nearVec(b[key], d[key], 1e-9), `${label}: ${key} ${fmt(b[key])} read back, ${fmt(d[key])} written`);
  });
  c.check(back.dims2d.length === expected.dims2d.length, `${where}: ${back.dims2d.length} 2D dimensions read back, ${expected.dims2d.length} written`);
  expected.dims2d.forEach((d, k) => {
    const b = back.dims2d[k];
    if (!c.check(!!b, `${where}: 2D dimension ${d.id} not read back`)) return;
    c.check(b.kind === d.kind && relDiff(b.measurement, d.measurement) <= MEASURE_TOLERANCE && b.text === d.text, `${where}: 2D dimension ${d.id}: ${b.kind} ${fmt(b.measurement)} "${b.text}" read back, ${d.kind} ${fmt(d.measurement)} "${d.text}" written`);
  });
  c.check(JSON.stringify(back.counts2d, Object.keys(back.counts2d).sort()) === JSON.stringify(expected.counts2d, Object.keys(expected.counts2d).sort()), `${where}: 2D entities ${JSON.stringify(back.counts2d)} read back, ${JSON.stringify(expected.counts2d)} written`);
  checkReportEntities(c, where, back, expected);
  return out;
}

/**
 * Import-report items about drawing entities (a type JCad wrote in ENTITIES, or a polyface's
 * VERTEX / SEQEND) other than "kept" are failures; AutoCAD's own objects (XRECORD, MATERIAL,
 * VISUALSTYLE, header variables ...) that JCad does not model are listed, not failed.
 */
function checkReportEntities(c, where, back, expected, allowed = (_item) => false) {
  const entityTypes = new Set(['POLYLINE', 'VERTEX', 'SEQEND', 'DIMENSION', ...Object.keys(expected.entityTypes ?? {})]);
  const lossy = (back.report?.items ?? []).filter((i) => entityTypes.has(i.type) && i.action !== 'kept' && !allowed(i));
  c.check(lossy.length === 0, `${where}: the import report has ${lossy.length} entity items: ${lossy.slice(0, 5).map((i) => `${i.action} ${i.type} ${i.handle ?? ''}: ${i.reason}`).join('; ')}`);
}

/**
 * JCad's reading of the AutoCAD DXF after AutoCAD removed every JCAD_3D XDATA (what another
 * program that drops unknown XDATA would hand back), against the documented foreign-file rules
 * (docs/3D-FILE-FORMAT.md): polyfaces become plain mesh solids with the same triangles; a
 * DIMENSION whose extrusion is not (0, 0, 1) becomes a 3D dimension in the OCS plane of its
 * normal, one with (0, 0, 1) takes the 2D path.
 */
function compareStripped(c, where, expected, back, strippedCount) {
  if (!c.check(!!back && !('error' in back), `${where}: JCad cannot read the XDATA-stripped AutoCAD DXF${back?.error ? `: ${back.error}` : ''}`)) return null;
  const isPlusZ = (d) => nearVec(d.normal, [0, 0, 1], 1e-12);
  const exp3d = expected.dims3d.filter((d) => !isPlusZ(d)), expFlat = expected.dims3d.filter(isPlusZ);
  const out = { strippedObjects: strippedCount, solids: back.solids.length, meshSolids: back.solids.filter((s) => s.featureKind === 'mesh').length, idsKept: back.solids.filter((s, k) => s.id === expected.solids[k]?.id).length, geometryMatched: 0, dims3d: back.dims3d.length, dims2d: back.dims2d.length, expectedDims3d: exp3d.length, expectedDims2d: expected.dims2d.length + expFlat.length, reportItems: back.report?.items ?? [], reportNotes: back.report?.notes ?? [] };
  c.check(back.solids.length === expected.solids.length, `${where}: ${back.solids.length} solids read back, ${expected.solids.length} written`);
  expected.solids.forEach((s, k) => {
    const b = back.solids[k];
    if (!b) return;
    const geometry = b.vertices === s.vertices && b.faces === s.faces && b.indices.every((v, i) => v === s.indices[i]) && b.positions.every((v, i) => near(v, s.positions[i], 1e-12));
    if (c.check(geometry, `${where}: solid ${k + 1} (${s.id}): triangles or coordinates changed without XDATA`)) out.geometryMatched++;
  });
  c.check(back.dims3d.length === exp3d.length, `${where}: ${back.dims3d.length} 3D dimensions read back, ${exp3d.length} expected (the ones whose normal is not +Z)`);
  exp3d.forEach((d, k) => {
    const b = back.dims3d[k];
    if (!c.check(!!b, `${where}: ${d.id} not read back as a 3D dimension`)) return;
    c.check(b.kind === d.kind && relDiff(b.measurement, d.measurement) <= MEASURE_TOLERANCE && nearVec(b.normal, d.normal, 1e-9) && near(b.elevation, d.elevation, 1e-9), `${where}: ${d.id}: read back as ${b.kind} ${fmt(b.measurement)} normal ${fmt(b.normal)} elevation ${fmt(b.elevation)}, written ${d.kind} ${fmt(d.measurement)} ${fmt(d.normal)} ${fmt(d.elevation)}`);
    if (b.text !== d.text) c.note(`${where}: ${d.id}: text "${d.text}" reads back as "${b.text}" without XDATA`);
    if (b.projected !== d.projected) c.note(`${where}: ${d.id}: projected ${d.projected} reads back as ${b.projected} without XDATA`);
  });
  const flatExpected = [...expected.dims2d.map((d) => ({ id: d.id, kind: d.kind, measurement: d.measurement, text: d.text })), ...expFlat.map((d) => ({ id: d.id, kind: d.kind, measurement: d.measurement, text: d.text, elevation: d.elevation }))];
  c.check(back.dims2d.length === flatExpected.length, `${where}: ${back.dims2d.length} 2D dimensions read back, ${flatExpected.length} expected (the 2D one and the +Z 3D ones)`);
  flatExpected.forEach((d, k) => {
    const b = back.dims2d[k];
    if (!b) return;
    c.check(b.kind === d.kind && relDiff(b.measurement, d.measurement) <= MEASURE_TOLERANCE, `${where}: ${d.id}: read back as 2D ${b.kind} ${fmt(b.measurement)}, written ${d.kind} ${fmt(d.measurement)}`);
    if (d.elevation) c.note(`${where}: ${d.id} (a +Z plane at elevation ${fmt(d.elevation)}) reads back as a flat 2D dimension: its elevation is lost without XDATA`);
  });
  // Foreign polyfaces are reported as simplified; that is the documented behaviour, not a loss.
  checkReportEntities(c, where, back, expected, (i) => i.type === 'POLYLINE' && i.action === 'simplified');
  return out;
}

// ------------------------------------------------------------------ main

async function main() {
  const repo = resolve(import.meta.dirname, '..');
  const executable = process.env.JCAD_AUTOCAD_CONSOLE || process.argv[2] || 'C:/Program Files/Autodesk/AutoCAD 2027/accoreconsole.exe';
  if (!existsSync(executable)) {
    console.error(`check:autocad:3d needs AutoCAD Core Console, which was not found at ${executable}. Install a licensed AutoCAD (Windows) or set JCAD_AUTOCAD_CONSOLE to its accoreconsole.exe. Nothing was validated.`);
    process.exitCode = 1;
    return;
  }
  const work = mkdtempSync(join(tmpdir(), 'jcad-autocad-3d-'));
  const jsonOut = resolve(process.env.JCAD_AUTOCAD_3D_OUT || join(tmpdir(), `jcad-autocad-3d-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  const helperFile = join(work, 'autocad-3d-helper.mjs');
  await build({ entryPoints: [join(repo, 'tests/helpers/autocad-3d-export.ts')], bundle: true, platform: 'node', format: 'esm', loader: { '.jhf': 'text' }, outfile: helperFile, logLevel: 'warning' });
  const helper = await import(pathToFileURL(helperFile).href);

  const inputsDir = join(work, 'inputs');
  mkdirSync(inputsDir);
  const inputs = FIXTURES.map((name) => {
    const file = join(inputsDir, `${name}.dxf`);
    copyFileSync(join(repo, 'tests/fixtures/3d', `${name}.dxf`), file);
    return { name: `${name}.dxf`, source: `tests/fixtures/3d/${name}.dxf`, file, known: null };
  });
  const generated = helper.dimensionsCase();
  const known = new Map(generated.known.map((k) => [k.id, k.value]));
  const dimsText = helper.dimensionsDxf();
  writeFileSync(join(inputsDir, 'dimensions.dxf'), dimsText);
  inputs.push({ name: 'dimensions.dxf', source: 'generated (tests/helpers/autocad-3d-export.ts)', file: join(inputsDir, 'dimensions.dxf'), known });
  // The same file with every DIMENSION's stored measurement (42) set to 0: AutoCAD must compute its own.
  const lines = dimsText.split('\r\n');
  let inDim = false;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    if (lines[i].trim() === '0') inDim = lines[i + 1] === 'DIMENSION';
    else if (inDim && lines[i].trim() === '42') lines[i + 1] = '0';
  }
  writeFileSync(join(inputsDir, 'dimensions-42-zeroed.dxf'), lines.join('\r\n'));
  inputs.push({ name: 'dimensions-42-zeroed.dxf', source: 'generated: dimensions.dxf with every group 42 = 0', file: join(inputsDir, 'dimensions-42-zeroed.dxf'), known });

  const results = [];
  let allFailures = 0;
  for (const [index, input] of inputs.entries()) {
    const c = makeChecker();
    const dir = join(work, `case-${index}`);
    mkdirSync(dir);
    const text = readFileSync(input.file, 'utf8');
    const expected = helper.jcadSummary(text);
    const native = nativeInventory(text);
    expected.entityTypes = native.counts;
    c.check(!expected.report || (expected.report.items.length === 0), `${input.name}: JCad's own reader reports ${expected.report?.items.length} items on its own file`);
    const s1 = join(dir, 'session.scr'), s2 = join(dir, 'dwg.scr');
    writeFileSync(s1, sessionScript(dir));
    writeFileSync(s2, dwgScript(dir));
    console.log(`\n== ${input.name}: AutoCAD session 1 (DXF in, AUDIT, report, DXFOUT, SAVEAS DWG, recompute)`);
    const run1 = await runConsole(executable, input.file, s1, dir, 'session');
    const dwg = join(dir, 'autocad-r2018.dwg');
    let run2 = null;
    if (existsSync(dwg)) {
      console.log(`== ${input.name}: AutoCAD session 2 (DWG in, AUDIT, report, DXFOUT)`);
      run2 = await runConsole(executable, dwg, s2, dir, 'dwg');
    }
    for (const run of [run1, run2]) {
      if (!run) continue;
      const where = `${input.name} [${run.label}]`;
      c.check(run.exitCode === 0 && !run.timedOut && !run.overflow && !run.error, `${where}: AutoCAD exit ${run.exitCode}${run.timedOut ? ', timed out' : ''}${run.overflow ? ', output overflow' : ''}${run.error ? `, ${run.error}` : ''}`);
      c.check(!run.rejected, `${where}: AutoCAD rejected the drawing (see ${run.label}.log)`);
      c.check(run.steps.includes('complete'), `${where}: the script did not complete (steps: ${run.steps.join(', ')})`);
      c.check(run.audit !== null, `${where}: no AUDIT summary in the log (${run.auditMatches} found)`);
      if (run.audit) c.check(run.audit.found === 0 && run.audit.fixed === 0, `${where}: AUDIT found ${run.audit.found} / fixed ${run.audit.fixed}`);
      c.check(run.lispErrors.length === 0, `${where}: AutoLISP errors: ${run.lispErrors.join('; ')}`);
      for (const w of run.warnings) c.note(`${where}: AutoCAD said: ${w}`);
    }
    c.check(!!run2, `${input.name}: AutoCAD wrote no DWG, so the DWG round trip did not run`);

    const loadedReport = readReport(join(dir, 'report-loaded.json'));
    const loaded = compareLoaded(c, `${input.name} [AutoCAD, loaded DXF]`, loadedReport, native, expected, input.known);
    const measurements = compareMeasurements(c, `${input.name} [AutoCAD, recomputed]`, loaded, readReport(join(dir, 'report-recomputed.json')), native);
    const dwgReport = readReport(join(dir, 'report-dwg.json'));
    const dwgLoaded = run2 ? compareLoaded(c, `${input.name} [AutoCAD, reopened DWG]`, dwgReport, native, expected, input.known) : null;

    const readBack = (file) => {
      const path = join(dir, file);
      if (!existsSync(path)) return { back: null, acadver: null };
      const t = readFileSync(path, 'utf8');
      const acadver = /\$ACADVER\r?\n\s*1\r?\n([^\r\n]*)/.exec(t)?.[1]?.trim() ?? null;
      try { return { back: helper.jcadSummary(t), acadver }; } catch (error) { return { back: { error: error.message }, acadver }; }
    };
    const roundTrips = {};
    for (const [key, file] of [['dxfout', 'autocad-r2018.dxf'], ['dxfoutRecomputed', 'autocad-recomputed-r2018.dxf'], ['dwgDxfout', 'autocad-dwg-r2018.dxf']]) {
      const { back, acadver } = readBack(file);
      roundTrips[key] = compareRoundTrip(c, `${input.name} [JCad reads ${file}]`, expected, back, acadver);
    }
    const strippedReport = readReport(join(dir, 'report-stripped.json'));
    const strippedLeft = strippedReport ? [...strippedReport.polyfaces, ...strippedReport.dimensions].filter((x) => x.xdata.some((a) => a.app === 'JCAD_3D')).length : null;
    c.check(strippedLeft === 0, `${input.name} [AutoCAD, XDATA removed]: ${strippedLeft ?? 'no report;'} objects still carry JCAD_3D`);
    const strippedCount = Number(/JCAD3D_STRIPPED (\d+)/.exec(readFileSync(join(dir, 'session.log'), 'utf8'))?.[1] ?? NaN);
    const stripped = compareStripped(c, `${input.name} [JCad reads autocad-stripped-r2018.dxf]`, expected, readBack('autocad-stripped-r2018.dxf').back, strippedCount);
    const result = {
      input: input.name, source: input.source,
      jcad: { solids: expected.solids.length, triangles: expected.solids.reduce((n, s) => n + s.faces, 0), dims3d: expected.dims3d.length, dims2d: expected.dims2d.length, polyfaceRecords: native.polyfaces.length, entityCounts: native.counts },
      autocad: { session: run1, dwgSession: run2, loaded, dwgLoaded },
      measurements, roundTrips, stripped, failures: c.failures, notes: c.notes,
    };
    results.push(result);
    allFailures += c.failures.length;
    printCase(result);
  }

  const summary = { tool: 'check:autocad:3d', executable, date: new Date().toISOString(), node: process.version, work, passed: allFailures === 0, failures: allFailures, results };
  mkdirSync(resolve(jsonOut, '..'), { recursive: true });
  writeFileSync(jsonOut, JSON.stringify(summary, null, 2));
  console.log(`\nJSON report: ${jsonOut}`);
  if (allFailures === 0 && process.env.JCAD_AUTOCAD_3D_KEEP !== '1') rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  else console.log(`AutoCAD evidence (inputs, scripts, logs, AutoCAD output) kept in ${work}`);
  console.log(allFailures === 0 ? 'check:autocad:3d PASSED: AutoCAD accepted every 3D input with AUDIT 0 / 0 and every comparison matched.' : `check:autocad:3d FAILED: ${allFailures} mismatches (listed above and in the JSON report).`);
  if (allFailures) process.exitCode = 1;
}

function printCase(r) {
  const s = r.autocad.session, d = r.autocad.dwgSession;
  const audit = (run) => run?.audit ? `${run.audit.found} found / ${run.audit.fixed} fixed` : 'none';
  const l = r.autocad.loaded ?? {};
  console.log(`-- ${r.input}: JCad ${r.jcad.solids} solids (${r.jcad.triangles} triangles), ${r.jcad.dims3d} 3D + ${r.jcad.dims2d} 2D dimensions`);
  console.log(`   AUDIT: DXF ${audit(s)} (${s.seconds} s); DWG ${audit(d)}${d ? ` (${d.seconds} s)` : ''}`);
  console.log(`   AutoCAD: ${l.polyfaces ?? '?'} polyfaces (${l.polyfacesMatched ?? 0} match, handles kept ${l.handlesKept ?? 0}, JCAD_3D XDATA on ${l.polyfaceXdata ?? 0}), ${l.dimensions ?? '?'} dimensions (JCAD_3D XDATA on ${l.dimensionXdata ?? 0}); extents ${fmt(l.extmin)} to ${fmt(l.extmax)}`);
  for (const m of r.measurements) console.log(`   ${m.is3d ? '3D' : '2D'} ${String(m.id).padEnd(24)} JCad ${fmt(m.jcadMeasurement).padEnd(20)} AutoCAD ${fmt(m.autocadMeasurement).padEnd(20)} rel ${m.relativeDifference === undefined ? '?' : m.relativeDifference.toExponential(1)}`);
  let previous = null;
  const printItems = (t, key) => {
    const grouped = new Map();
    for (const i of t.reportItems) { const k = `${i.action} ${i.type}: ${i.reason}`; grouped.set(k, (grouped.get(k) ?? 0) + 1); }
    const lines = [...grouped].map(([k, n]) => `     - ${n} x ${k}`);
    if (previous && previous.text === lines.join('\n')) console.log(`     (the same ${t.reportItems.length} import-report items as ${previous.key})`);
    else for (const line of lines) console.log(line);
    previous = { key, text: lines.join('\n') };
  };
  for (const [key, t] of Object.entries(r.roundTrips)) {
    if (!t || t.error) { console.log(`   round trip ${key}: ${t?.error ?? 'no output'}`); continue; }
    console.log(`   round trip ${key} (${t.acadver}): ${t.solids} solids (geometry identical ${t.geometryMatched}, ids ${t.idsKept}, histories ${t.historiesKept}, names ${t.namesKept}), ${t.dims3d} 3D dims (ids ${t.dimIdsKept}, plane frames ${t.planesKept}), ${t.dims2d} 2D dims; import report ${t.reportItems.length} items${t.reportNotes.length ? `, notes: ${t.reportNotes.join(' | ')}` : ''}`);
    printItems(t, key);
  }
  const x = r.stripped;
  if (x) {
    console.log(`   without JCAD_3D (AutoCAD removed it from ${x.strippedObjects} objects): ${x.solids} solids (${x.meshSolids} plain meshes, geometry identical ${x.geometryMatched}, ids kept ${x.idsKept}), ${x.dims3d}/${x.expectedDims3d} 3D dims, ${x.dims2d}/${x.expectedDims2d} 2D dims; import report ${x.reportItems.length} items${x.reportNotes.length ? `, notes: ${x.reportNotes.join(' | ')}` : ''}`);
    printItems(x, 'the round trips');
  }
  for (const n of r.notes) console.log(`   note: ${n}`);
  for (const f of r.failures) console.log(`   MISMATCH: ${f}`);
  console.log(`   ${r.failures.length ? `FAILED (${r.failures.length})` : 'passed'}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
