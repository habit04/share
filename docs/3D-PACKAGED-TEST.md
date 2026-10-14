# JCad 3D: verifying the kernel security controls in a Windows test build

This page explains how to check the two security controls of the experimental 3D geometry kernel
in the real Electron runtime. The controls are described in
[SECURITY-REVIEW.md](SECURITY-REVIEW.md) (E-19, E-20) and [3D-KERNEL.md](3D-KERNEL.md):

- **E-19, worker CSP.** The `jcad://app/` protocol handler sends the Manifold worker script
  (`assets/worker/manifold.worker-<hash>.js`) its own `Content-Security-Policy` header,
  `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; base-uri 'none'`.
  The renderer page keeps its unchanged meta CSP.
- **E-20, memory limit.** The worker refuses WebAssembly memory growth past 1 GiB. When that
  happens, the call fails with "The 3D kernel reached its 1 GiB memory limit; the operation was
  abandoned and the model is unchanged.", and the worker is replaced.

The worker is a thread of the renderer process. Neither control turns it into memory or crash
isolation.

## What the script checks

`scripts/e2e-3d-security.mjs` (`npm run e2e:3d-security`) is a Playwright-Electron driver modelled
on `scripts/test-build-e2e.mjs`. It is not part of CI. It launches the app with a private, temporary
profile and sets `JCAD_3D_TEST_HOOKS=1`. Then it:

1. checks that the window is `jcad://app/index.html?jcad3dTestHooks=1`. The main process adds that
   query only when `JCAD_3D_TEST_HOOKS=1` is set in a build that allows inspection, and the kernel's
   test probes exist only behind it;
2. turns on **Options > Files > Experimental: 3D modelling** through `localStorage`, reloads, and
   runs `3DMODE`;
3. runs a union of two half-overlapping unit cubes through the worker kernel and checks the volume
   (1.5) and the kernel name (`Manifold 3.5.4 (worker)`);
4. runs the worker's `probe-csp`, which tries `fetch()` and `import()` of
   `https://jcad-csp-probe.invalid/...` from inside the worker. It checks that both are blocked with
   `securitypolicyviolation` events (`connect-src`, `script-src-elem`). The `.invalid` host can never
   resolve, so nothing leaves the machine either way;
5. fetches the worker script URL from the page and checks the response headers: exactly the
   worker CSP, and a JavaScript content type. It also checks that `index.html` and the main
   script carry no CSP header;
6. checks that `WebAssembly.compile` on the renderer page is still refused by the renderer CSP;
7. runs `probe-memory` (Manifold solids allocated inside the WebAssembly module, then freed) up to
   2,048 pages (128 MiB), which must succeed. It then runs it up to 16,385 pages (just over 1 GiB),
   which must fail with the `memory-limit` KernelError and the exact message;
8. checks that the worker file under another letter case and under its 8.3 short name is either not served or served with the worker CSP;
9. checks that the worker was replaced once and that a follow-up subtraction succeeds, that the
   renderer still answers, and that there were no page errors.

It exits with 0 only when every check passes. `JCAD_3D_SECURITY_OUT=<file>` also writes the
results as JSON.

## Commands (Windows, from the repository root, after `npm install`)

Development build (`electron .` on `dist/`):

```
npm run build
npm run e2e:3d-security
```

Unpacked Windows test build without the Rust toolchain:

```
npm run dist:test:no-dwg
npm run e2e:3d-security -- --packaged "release-test-no-dwg/win-unpacked/JCad Electrical.exe"
```

`dist:test:no-dwg` runs `npm run build`, then
`electron-builder --dir --config scripts/electron-test-build.cjs --publish never` with
`JCAD_TEST_BUILD_WITHOUT_DWG_WRITER=1`. The opt-out is handled in
`scripts/electron-test-build-config.cjs`, and only there:

- the build has no `dwg-writer` extra resource, so DWG saving reports the writer as unavailable;
- the output goes to its own `release-test-no-dwg/` folder, with `TEST-ONLY-NO-DWG-WRITER-`
  artifact names and `jcadTestBuildWithoutDwgWriter` in the packaged metadata;
- electron-builder's native-module rebuild is skipped (`npmRebuild: false`; the app has no native
  production dependencies), so the build never touches `node_modules`;
- the opt-out is refused when `CI` or `GITHUB_ACTIONS` is set, and `npm run check:workflows` fails
  if any workflow mentions it.

Everything else matches the regular test build: the same ASAR, the same fuses as shipping except
`EnableNodeCliInspectArguments` (the script checks the fuse wire before it launches), and no
signing or installer. Nothing in `release.yml`, `pages.yml` or the signing scripts uses it.

Full test build (needs the Rust toolchain for the DWG writer, as in `release.yml`):

```
npm run dist:test
npm run e2e:3d-security -- --packaged "release-test/win-unpacked/JCad Electrical.exe"
```

Memory measurements in Node (peak WebAssembly memory of the fixture and performance Booleans
under the 1 GiB guard; the table is in [3D-KERNEL.md](3D-KERNEL.md#memory-limit)):

```
npx cross-env JCAD_BENCH=1 vitest run tests/model3d-memory-limit.test.ts --silent=false
```

The table lines start with `memlimit |`.

### ASAR and unpacked files

The header is decided from the file that is actually served, after the protocol handler resolves
the request with `realpath`: `'/' + path.relative(realRoot, realFile)`, not from the requested URL.
This matters where the bundle is plain files on a Windows disk: in the development build (`electron .`
serves `dist/`), a URL that uses another letter case or the 8.3 short name (`MANIFO~1.JS`) resolves
to the worker file and must get the header too. Unit tests cover both aliases with a real short
name (skipped when the volume has 8.3 names disabled). In packaged builds `dist/` sits inside
`resources/app.asar` (it is not in `asarUnpack`). The archive has no short names and looks names
up exactly, so such aliases are not served at all (404). The script checks both kinds of alias in
each build: they must either be refused or carry the worker CSP.

## Results

| Date | Build | Result |
| --- | --- | --- |
| 2026-10-12 | Development build, `electron .` on `dist/` (Electron 44.7.0, Windows 11 x64) | 19/19 checks passed; the letter-case and 8.3 aliases of the worker were served with the worker CSP |
| 2026-10-12 | Unpacked test build, `npm run dist:test:no-dwg` (ASAR, test fuses, no DWG writer, unsigned) | 20/20 checks passed (fuse check included): worker CSP header present, the aliases not served (404), remote fetch and import blocked, 1 GiB refusal in about 3 s, worker replaced, follow-up Boolean ok |

## What this does not verify

- **An installed, signed release build.** The script cannot drive one, because shipping fuses
  disable inspection and the main process ignores `JCAD_3D_TEST_HOOKS` there. The test build has
  the same `dist/` and `electron/` code in its ASAR, but a different inspection fuse, package
  metadata, signature and installer, so the result carries over by construction. It is not
  observed.
- **macOS and Linux** builds. Nothing here was run on them.
- **The browser edition and the Vite dev server.** They keep Vite's default file layout and serve
  the worker without the header; static hosting cannot set one (E-19, residual).
- **Real system memory pressure.** The limit stops the kernel at 1 GiB of WebAssembly memory. Whether
  the renderer survives when the machine has less than that free is not tested.


## Windows Application Control blocker (observed 2026-10-13)

On a machine with **Smart App Control** on (`HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy`
`VerifiedAndReputablePolicyState = 1`), the freshly built, unsigned test executable
`release-test-no-dwg\win-unpacked\JCad Electrical.exe` is refused with "An Application Control
policy has blocked this file" (bash: "Permission denied", exit 126), so `e2e:3d-security --packaged`
cannot launch it. Do not weaken that policy to run the check. Instead:

- `node scripts/e2e-3d-security.mjs --asar release-test-no-dwg/win-unpacked/resources/app.asar`
  drives the packaged archive with the signed development Electron binary. It covers the packaged
  ASAR layout, the `jcad://app/` handler, the worker under `assets/worker/`, its CSP and the memory
  cap (19 checks). It does not cover the executable's fuses; verify those separately with
  `node scripts/electron-fuse-policy.mjs` / the fuses check the script performs on `--packaged`.
- Required environment for the full `--packaged` run: a Windows machine where the unsigned test
  build may run (Smart App Control off or in evaluation mode, or a WDAC policy that allows it), or
  a publisher-signed test build produced by the signing pipeline. Record which one was used.

Result on this machine, final merged commit: `--asar` 19/19; the executable's fuses verified as an
inspection-enabled test build; `--packaged` launch blocked by Smart App Control. The security branch
state before the dimension merge had passed `--packaged` 20/20 on the same machine earlier that day
(before the policy blocked newly built executables).
