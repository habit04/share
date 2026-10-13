/**
 * Wording of the 3D kernel's security controls (docs/SECURITY-REVIEW.md E-19 / E-20): the docs and
 * code never present the kernel worker as memory or crash isolation (it is a thread of the renderer
 * process), the DWG refusal is quoted exactly where it is documented, and the verification page
 * names commands that exist.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODEL3D_DWG_REFUSAL } from '../src/model3d/save-guard';
import { memoryLimitError } from '../src/model3d/kernel/kernel';

const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
/** The 3D part of the security review (E-19 onwards). */
const review3d = (): string => read('docs/SECURITY-REVIEW.md').split('## Experimental 3D track')[1] ?? '';
const kernelSources = readdirSync('src/model3d/kernel').filter((f) => f.endsWith('.ts')).map((f) => join('src/model3d/kernel', f));

/** Phrases that claim the worker contains crashes or memory (the earlier wording, now wrong). */
const OVERCLAIMS = [/only kills the worker/i, /crash containment/i, /without taking the editor with it/i, /\bis contained\b/i, /memory isolation for/i, /isolates? the (kernel|worker)/i];

describe('3D kernel security wording', () => {
  it('never describes the worker as memory or crash isolation', () => {
    const texts: Array<[string, string]> = [['docs/3D-KERNEL.md', read('docs/3D-KERNEL.md')], ['docs/SECURITY-REVIEW.md (3D)', review3d()], ['docs/3D-PACKAGED-TEST.md', read('docs/3D-PACKAGED-TEST.md')], ...kernelSources.map((f) => [f, read(f)] as [string, string])];
    for (const [name, text] of texts) for (const re of OVERCLAIMS) expect(re.test(text), `${name}: ${re}`).toBe(false);
  });

  it('says plainly that the worker shares the renderer process', () => {
    expect(read('docs/3D-KERNEL.md')).toContain('it is **not** memory or crash isolation');
    expect(review3d()).toContain('not process, memory or crash isolation');
    expect(review3d()).toContain('The worker is therefore not memory or crash isolation');
    expect(read('src/model3d/kernel/manifold-kernel.ts')).toContain('it is not memory or crash isolation');
  });

  it('states E-19 / E-20 as mitigated with what was and was not verified', () => {
    const r = review3d();
    for (const id of ['E-19', 'E-20']) {
      const section = r.split(`### ${id} `)[1]!.split('\n---\n')[0]!;
      expect(section, id).toMatch(/\*\*Status \(2026-10-12, branch `feature\/3d-security`\): mitigated\.\*\* Verified:/);
      expect(section, id).toContain('**Not yet verified** in an installed, signed release build');
    }
    expect(r.replace(/\s+/g, ' ')).toContain(memoryLimitError().message);
    expect(read('docs/3D-KERNEL.md').replace(/\s+/g, ' ')).toContain(memoryLimitError().message);
  });

  it('quotes the DWG refusal exactly and says which formats keep the 3D model', () => {
    for (const doc of ['docs/DWG-SAVING.md', 'docs/USER-MANUAL.md', 'docs/3D-FILE-FORMAT.md']) {
      const text = read(doc).replace(/\n\s*/g, ' ');
      expect(text, doc).toContain(`"${MODEL3D_DWG_REFUSAL}."`);
      expect(text, doc).toMatch(/construction histor/);
      expect(text, doc).toContain('where they fit the file limits');
      expect(text, doc).toMatch(/autosave/i);
    }
  });

  it('documents commands that exist', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
    const page = read('docs/3D-PACKAGED-TEST.md');
    for (const name of ['dist:test:no-dwg', 'e2e:3d-security', 'dist:test', 'build']) {
      expect(page, name).toContain(`npm run ${name}`);
      expect(scripts[name], name).toBeTruthy();
    }
    expect(scripts['dist:test:no-dwg']).toContain('JCAD_TEST_BUILD_WITHOUT_DWG_WRITER=1');
    expect(scripts['dist:test']).not.toContain('JCAD_TEST_BUILD_WITHOUT_DWG_WRITER');
  });
});
