/**
 * Facts about the shipped Manifold WebAssembly that docs/SECURITY-REVIEW.md E-20 relies on, read
 * from node_modules/manifold-3d/manifold.wasm itself so the review stays true when the dependency
 * changes: one exported linear memory (no imported memory), 256 initial pages (16 MiB) and a
 * declared maximum of 65,536 pages (4 GiB), and manifold.js caps heap growth at 4,294,901,760
 * bytes. If this test fails, update E-20 (and decide whether an engine-enforced cap is due).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const WASM = 'node_modules/manifold-3d/manifold.wasm';

/** Memory section entries (section id 5) of a WebAssembly binary: [flags, min, max?] in pages. */
function memories(bytes: Uint8Array): Array<{ min: number; max: number | null }> {
  let p = 8;
  const leb = (): number => {
    let r = 0, shift = 0, c: number;
    do { c = bytes[p++]!; r += (c & 0x7f) * 2 ** shift; shift += 7; } while (c & 0x80);
    return r;
  };
  const out: Array<{ min: number; max: number | null }> = [];
  while (p < bytes.length) {
    const id = bytes[p++]!;
    const len = leb();
    const end = p + len;
    if (id === 5) for (let n = leb(); n > 0; n--) { const flags = leb(); const min = leb(); out.push({ min, max: flags & 1 ? leb() : null }); }
    p = end;
  }
  return out;
}

describe('Manifold WebAssembly memory declaration (SECURITY-REVIEW E-20)', () => {
  it('declares one exported memory of 16 MiB growing to at most 4 GiB', () => {
    const bytes = new Uint8Array(readFileSync(WASM));
    const mod = new WebAssembly.Module(bytes);
    expect(WebAssembly.Module.imports(mod).filter((i) => i.kind === 'memory')).toEqual([]);
    expect(WebAssembly.Module.exports(mod).filter((e) => e.kind === 'memory')).toHaveLength(1);
    expect(memories(bytes)).toEqual([{ min: 256, max: 65_536 }]);
  });

  it('lets the Emscripten heap grow to just under 4 GiB', () => {
    const js = readFileSync('node_modules/manifold-3d/manifold.js', 'utf8');
    expect(js).toContain('getHeapMax=()=>4294901760');
  });
});
