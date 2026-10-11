# Work in progress: security review and reader gaps (branch reliability/security-interchange)

Paused on request. Base 648e063; every commit below passed `npm run typecheck:all` and
`npm run lint`, and the targeted vitest files; the full gate suite has not been run yet.

## Done (one commit each unless noted)

- E-5 atomic writes and symbolic links (two commits): a destination that is a link is refused
  (ELOOP, own message in both file-error twins); the folder is resolved once ("pinned") and
  re-checked before the rename; linked folders on the way save normally; by-name project
  drawings stay in the project folder (`registry.writeRoot`, persisted); copy fallback kept.
- E-6 tokenizer `trimEnd()`, field expressions scanned linearly (`tests/dxf-redos.test.ts`).
- E-7 DWG worker limits: 512 MB input, 2048 MB worker heap, 2 GiB WebAssembly cap, 60 s + 1 s/MB
  time limit, no main-thread fallback; bounded reads (`electron/resource-limits.cjs`).
- E-13 2,000,000 objects per block reference, self-inserting blocks expanded once, readers
  report as "kept", EXPLODE leaves such references.
- E-12 permission handlers and web-contents guards (`electron/web-security.cjs`).
- E-15 CSP directives, DevTools only unpackaged, fuses (inspect off; packaged smoke verifies
  the fuses and re-enables --inspect in its own copy; `scripts/electron-fuses.mjs`).
- E-16 report redaction with opt-in; E-17 hasOwn pack keys; E-18 sheets <= 200 in.
- E-10 SHA-256-only plugin trust + trust model in docs/PLUGIN-API.md.
- E-8 downloaded update verified (SHA-512, Windows publisher signature) after download and
  before quitAndInstall (`electron/update-verify.cjs`); unsigned builds still self-update.
- Nested block cache invalidation (PR #2 item 6).
- Reader gaps from PR #2: DIMDSEP, DIMTXSTY, DIMLWD/DIMLWE, DIMTZIN, DIMAPOST [], DSTYLE
  overrides, xref layer flags, hatch 71 = 0, 2D LIMMIN/LIMMAX, plot-style dictionary, nested
  dimensions' *D blocks (+ ported tests). SUPPORT-MATRIX updated for these.

## Next (in this order)

1. TABLESTYLE (todo at tests/interchange-fixtures.test.ts ~"cells without an override"):
   port `readTableStyle` / `readTable(o, base, style)` from PR #2 into
   src/io/dxf/read-annotations.ts, `ctx.tableStyles` in read-core.ts, pre-scan of the OBJECTS
   section in reader.ts, group 342 lookup in read-entities.ts ACAD_TABLE.
2. IMAGE in layouts (todo "paper-space IMAGE"): key `pendingImages` by entity id and resolve
   after `layoutReader.build` in reader.ts.
3. MTEXT columns (todo "MTEXT static columns"): port src/core/mtext.ts columns, reader
   (`readMTextColumns`, main-group slicing), writer `JCAD_MTEXT_COLUMNS` XDATA + APPID, quiet
   XDATA list, columns scaled in blockTransform / similarityTransform.
4. Remaining todos (DIM-less): leave with a one-line reason if any remain.
5. PR #2 low-risk ports still open: viewport scene cache + spatial index warm-up
   (src/render/viewport.ts), ladder reference finder (src/electrical/ladder.ts, reports.ts),
   release provenance / attest, bench budgets, fixture manifest, output scanner.
6. e2e additions: save under a symlinked folder, image next to a drawing known under a linked
   path, symlinked destination refused with the ELOOP message, permission denial / clipboard.
7. E-2 Electron 44.7 + Vitest 5 bump as its own commit, on a copy of node_modules (the shared
   install must not be modified); keep only if every gate passes.
8. Docs: SECURITY-REVIEW status rows, CHANGELOG Unreleased, USER-MANUAL, SUPPORT-MATRIX rest.
9. Full gates (typecheck:all, lint, check:workflows, vitest, build, build:site, ui-check,
   screenshots, e2e, e2e:flows).

Note: `npm install --package-lock-only` (for the @electron/fuses devDependency) rewrote the
hidden lockfile `node_modules/.package-lock.json` of the shared install with the same content
(no package changed); no other npm command touched the shared node_modules.
