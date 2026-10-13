import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/**
 * The browser edition parses DWG files with LibreDWG's WebAssembly (Emscripten + embind), which
 * needs `'unsafe-eval'` for its generated invokers. Only the website / dev-server page gets that
 * relaxed policy; the Electron renderer keeps the strict CSP written in index.html.
 */
function webCspPlugin(): Plugin {
  return {
    name: 'jcad-web-csp',
    transformIndexHtml(html) {
      return html.replace(/content="default-src 'self';/, `content="default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval';`);
    },
  };
}

export default defineConfig(({ command, mode }) => {
  // The browser edition (website, `vite build --mode site`) and the dev server read DWG files
  // with LibreDWG's WebAssembly in a worker (src/io/dwg-browser-worker.ts). The Electron renderer
  // build (`npm run build`, mode "production") leaves that code out: the main process does it.
  // Vitest also runs with command "serve" (mode "test"); its Node environment must not load the wasm.
  const web = mode === 'site' || (command === 'serve' && mode !== 'test');
  return {
    base: './',
    worker: { format: 'es' },
    resolve: { alias: web ? [] : [{ find: './dwg-browser-worker-factory', replacement: fileURLToPath(new URL('./src/io/dwg-browser-worker-disabled.ts', import.meta.url)) }] },
    plugins: web ? [webCspPlugin()] : [],
    define: { __APP_VERSION__: JSON.stringify(pkg.version), __JCAD_WEB__: JSON.stringify(web), __JCAD_GPU_EXPERIMENTAL__: JSON.stringify(mode === 'gpu-experimental') },
    build: { outDir: mode === 'site' ? 'site-dist/app' : 'dist', emptyOutDir: true, target: 'chrome120' },
    server: { port: mode === 'gpu-experimental' ? 5189 : 5173, strictPort: true },
    test: { environment: 'node', include: ['tests/**/*.test.ts'] },
  };
});
