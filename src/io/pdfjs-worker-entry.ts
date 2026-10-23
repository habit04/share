// The pdfjs dedicated worker entry (P28 provisional dep ruling, 2026-10-21).
// Vite emits worker entries under assets/worker/ (vite.config.ts
// workerFileNames / rollup worker entry naming), where
// electron/renderer-origin.cjs serves them with the path-scoped WORKER_CSP:
//   script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'
// — the same scoped posture as the manifold kernel worker. The page CSP is
// never widened, and no eval is enabled anywhere in the page; pdfjs runs
// with isEvalSupported:false regardless (see underlay-pdfjs.ts).
import './pdfjs-runtime-shims';
import 'pdfjs-dist/build/pdf.worker.min.mjs';
