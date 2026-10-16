import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The independent verifier (validation/restricted-pdf/verify.py) exercised
 * end to end: the committed fixture pairs must pass at their receipted
 * counts, and every generated negative control must fail. The verifier is
 * a Python tool (pypdf + cryptography), so this suite runs only when a
 * Python with those packages is importable — set JCAD_PYTHON to choose
 * the interpreter. Where no such Python exists the suite skips and says
 * so; the sandbox and the Windows acceptance pass both run it for real.
 */
function findPython(): string | null {
  const candidates = [process.env.JCAD_PYTHON, 'python3', 'python'].filter((value): value is string => !!value);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'import pypdf, cryptography'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
}
const python = findPython();
const py: string = python ?? 'python3'; // used only inside the suite, which skips when python is null
const VALIDATION = join(__dirname, '..', 'validation', 'restricted-pdf');
const FIXTURES = join(VALIDATION, 'fixtures');
const OWNER = 'jcad-124-fixture-owner';

function verify(plain: string, enc: string, owner = false) {
  const args = [join(VALIDATION, 'verify.py'), plain, enc];
  if (owner) args.push('--owner-password', OWNER);
  const run = spawnSync(py, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const receipt = JSON.parse(run.stdout) as { passed: number; total: number; checks: { name: string; ok: boolean }[] };
  return { status: run.status, receipt };
}

describe.skipIf(!python)('independent restricted-PDF verifier (12.4 corrections)', () => {
  it('the known-owner fixture pair passes 33/33', () => {
    const { status, receipt } = verify(join(FIXTURES, 'plaintext.pdf'), join(FIXTURES, 'restricted.enc-known.pdf'), true);
    expect(status).toBe(0);
    expect(receipt.passed).toBe(33);
    expect(receipt.total).toBe(33);
  }, 60_000);

  it('the production fixture pair passes 32/32', () => {
    const { status, receipt } = verify(join(FIXTURES, 'plaintext.pdf'), join(FIXTURES, 'restricted.enc.pdf'));
    expect(status).toBe(0);
    expect(receipt.passed).toBe(32);
    expect(receipt.total).toBe(32);
  }, 60_000);

  it('every negative control fails, on the check meant to catch it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jcad-negative-controls-'));
    execFileSync(py, [join(VALIDATION, 'make-negative-controls.py'), dir]);
    const plain = join(FIXTURES, 'plaintext.pdf');
    const encKnown = join(FIXTURES, 'restricted.enc-known.pdf');
    const cases: { file: string; against: string; owner: boolean; check: string }[] = [
      { file: 'negative-wrong-width.pdf', against: encKnown, owner: true, check: 'role census matches' },
      { file: 'negative-corrupt-mapping.pdf', against: encKnown, owner: true, check: 'role census matches' },
      { file: 'negative-broken-reference.pdf', against: encKnown, owner: true, check: 'font BaseFont sets match by role' },
    ];
    for (const entry of cases) {
      const { status, receipt } = verify(join(dir, entry.file), entry.against, entry.owner);
      expect(status, entry.file).toBe(1);
      const failed = receipt.checks.filter((check) => !check.ok).map((check) => check.name);
      expect(failed, entry.file).toContain(entry.check);
    }
    const metadata = verify(plain, join(dir, 'negative-false-metadata.pdf'), true);
    expect(metadata.status).toBe(1);
    const failed = metadata.receipt.checks.filter((check) => !check.ok).map((check) => check.name);
    expect(failed).toContain('/EncryptMetadata resolves to true (metadata encrypted)');
  }, 120_000);
});
