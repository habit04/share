import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';

// scripts/screenshot-compare.mjs against a scratch folder (JCAD_SCREENSHOTS): it must pass on
// identical images, fail on a changed one (and write the diff), fail on missing / unapproved
// screenshots, honour masks and ignore lists, and approve.

const script = join(import.meta.dirname, '..', 'scripts', 'screenshot-compare.mjs');
const root = mkdtempSync(join(tmpdir(), 'jcad-shots-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function png(w: number, h: number, paint?: (x: number, y: number) => [number, number, number] | null): Buffer {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const c = paint?.(x, y) ?? [240, 240, 240];
      const i = (y * w + x) * 4;
      p.data[i] = c[0];
      p.data[i + 1] = c[1];
      p.data[i + 2] = c[2];
      p.data[i + 3] = 255;
    }
  return PNG.sync.write(p);
}

function run(dir: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [script, ...args], { env: { ...process.env, JCAD_SCREENSHOTS: dir }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('screenshot:compare / screenshot:approve', () => {
  const dir = join(root, 'shots');
  mkdirSync(join(dir, 'baseline'), { recursive: true });
  const box = (x0: number, y0: number, s: number) => (x: number, y: number): [number, number, number] | null => (x >= x0 && x < x0 + s && y >= y0 && y < y0 + s ? [200, 0, 0] : null);

  it('approves, then matches identical screenshots', () => {
    writeFileSync(join(dir, 'a.png'), png(100, 80, box(10, 10, 20)));
    writeFileSync(join(dir, 'b.png'), png(100, 80));
    expect(run(dir, '--approve').code).toBe(0);
    expect(existsSync(join(dir, 'baseline', 'a.png'))).toBe(true);
    const r = run(dir);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/2 match, 0 failed/);
  });

  it('fails on a regression and writes the diff and actual images', () => {
    writeFileSync(join(dir, 'a.png'), png(100, 80, box(40, 10, 20)));
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL a\.png: \d+ pixel\(s\) differ/);
    expect(existsSync(join(dir, 'diff', 'a.diff.png'))).toBe(true);
    expect(existsSync(join(dir, 'diff', 'a.actual.png'))).toBe(true);
  });

  it('tolerates differences below maxDiffRatio, and masked regions', () => {
    writeFileSync(join(dir, 'a.png'), png(100, 80, (x, y) => box(10, 10, 20)(x, y) ?? (x === 99 && y === 79 ? [0, 0, 0] : null)));
    writeFileSync(join(dir, 'baseline', 'config.json'), JSON.stringify({ default: { threshold: 0.1, maxDiffRatio: 0.001 } }));
    expect(run(dir).code).toBe(0); // 1 pixel of 8,000
    writeFileSync(join(dir, 'a.png'), png(100, 80, box(40, 10, 20)));
    writeFileSync(join(dir, 'baseline', 'config.json'), JSON.stringify({ images: { 'a.png': { masks: [[0, 0, 70, 40]] } } }));
    expect(run(dir).code).toBe(0);
  });

  it('fails on a size change, a missing screenshot and an unapproved one; ignore skips files', () => {
    writeFileSync(join(dir, 'baseline', 'config.json'), '{}');
    writeFileSync(join(dir, 'a.png'), png(101, 80, box(10, 10, 20)));
    let r = run(dir);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL a\.png: size 101x80, approved 100x80/);
    writeFileSync(join(dir, 'a.png'), png(100, 80, box(10, 10, 20)));
    rmSync(join(dir, 'b.png'));
    writeFileSync(join(dir, 'c.png'), png(10, 10));
    r = run(dir);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL b\.png: no screenshot was taken/);
    expect(r.out).toMatch(/FAIL c\.png: new screenshot without an approved baseline/);
    writeFileSync(join(dir, 'baseline', 'config.json'), JSON.stringify({ ignore: ['b.png', 'c.png'] }));
    expect(run(dir).code).toBe(0);
    // Approve one file only; --prune removes baselines whose screenshot is gone.
    writeFileSync(join(dir, 'baseline', 'config.json'), '{}');
    expect(run(dir, '--approve', 'c.png').code).toBe(0);
    expect(existsSync(join(dir, 'baseline', 'c.png'))).toBe(true);
    expect(run(dir, '--approve', '--prune').code).toBe(0);
    expect(existsSync(join(dir, 'baseline', 'b.png'))).toBe(false);
    expect(readFileSync(join(dir, 'baseline', 'config.json'), 'utf8')).toBe('{}');
  });
});
