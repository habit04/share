/**
 * Security review E-15: renderer and package hardening that CI cannot exercise without building
 * installers. The page's Content-Security-Policy, developer tools only in development runs, and
 * the Electron fuses the installers ship with (package.json build.electronFuses): RunAsNode,
 * NODE_OPTIONS and --inspect off, the application only from app.asar. The packaged smoke test
 * verifies the fuses of every installer and switches --inspect back on in its own copy for
 * Playwright (scripts/electron-fuses.mjs); the fuse helpers are tested here on a small file that
 * carries a fuse wire like the Electron binary.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHIPPED_FUSES, shippedFuseProblems, allowInspectForTests, shipsFuses } from '../scripts/electron-fuses.mjs';
import { readSource } from './helpers/main-process';

const root = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'jcad-fuses-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A file with the fuse wire Electron binaries carry: sentinel, version 1, length 8, states. */
function fakeBinary(states: number[]): string {
  const file = join(dir, `electron-${Math.random().toString(36).slice(2)}`);
  writeFileSync(file, Buffer.concat([Buffer.from('ELF padding '), Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'), Buffer.from([1, states.length, ...states]), Buffer.from(' more')]));
  return file;
}
const ON = 49;
const OFF = 48;

describe('Content-Security-Policy and developer tools', () => {
  it('the page forbids base URLs, plugins, frames and form submissions on top of default-src self', () => {
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(readFileSync(join(root, 'index.html'), 'utf8'))![1]!;
    const directives = csp.split(';').map((d) => d.trim()).filter(Boolean);
    expect(directives).toEqual(["default-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "base-uri 'none'", "object-src 'none'", "frame-src 'none'", "form-action 'none'"]);
    expect(csp).not.toMatch(/unsafe-eval/);
  });
  it('the View menu has Toggle Developer Tools only when the application is not packaged', () => {
    const menu = readSource('electron/main/menu.cjs');
    expect(menu).toMatch(/\.\.\.\(app\.isPackaged \? \[\] : \[\/\*\* @type \{Electron\.MenuItemConstructorOptions\} \*\/ \(\{ role: 'toggleDevTools' \}\)\]\)/);
    expect(menu.match(/toggleDevTools/g)).toHaveLength(1);
  });
});

describe('Electron fuses (package.json build.electronFuses, scripts/electron-fuses.mjs)', () => {
  it('the build switches off RunAsNode, NODE_OPTIONS and --inspect and loads the app from app.asar only', () => {
    expect(pkg.build.electronFuses).toEqual({ ...SHIPPED_FUSES, resetAdHocDarwinSignature: true });
    expect(SHIPPED_FUSES).toEqual({ runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false, onlyLoadAppFromAsar: true });
    // The page is served from file://: its extra privileges (module scripts, fetch) are needed.
    expect(pkg.build.electronFuses).not.toHaveProperty('grantFileProtocolExtraPrivileges');
  });

  it('shippedFuseProblems reads the wire: none for a build as shipped, each wrong fuse named otherwise', async () => {
    const shipped = fakeBinary([OFF, ON, OFF, OFF, ON, ON, OFF, ON]);
    expect(await shippedFuseProblems(shipped)).toEqual([]);
    const stock = fakeBinary([ON, ON, ON, ON, OFF, OFF, OFF, ON]);
    expect(await shippedFuseProblems(stock)).toEqual([
      'RunAsNode is on, expected off',
      'EnableNodeOptionsEnvironmentVariable is on, expected off',
      'EnableNodeCliInspectArguments is on, expected off',
      'OnlyLoadAppFromAsar is off, expected on',
    ]);
    await expect(shippedFuseProblems(join(dir, 'missing'))).rejects.toThrow();
  });

  it('allowInspectForTests switches on --inspect only', async () => {
    const shipped = fakeBinary([OFF, ON, OFF, OFF, ON, ON, OFF, ON]);
    await allowInspectForTests(shipped);
    expect(await shippedFuseProblems(shipped)).toEqual(['EnableNodeCliInspectArguments is on, expected off']);
  });

  it('installers from the release after 0.4.1 ship the fuses; older ones are not checked', () => {
    expect(shipsFuses('0.4.1')).toBe(false);
    expect(shipsFuses('v0.4.0')).toBe(false);
    for (const v of ['0.4.2', '0.5.0', '1.0.0', 'v0.4.2-beta.1']) expect(shipsFuses(v), v).toBe(true);
    expect(() => shipsFuses('latest')).toThrow(/Invalid version/);
  });

  it('the packaged smoke test checks the fuses before the end-to-end run and fails on a wrong one', () => {
    const smoke = readFileSync(join(root, 'scripts', 'packaged-smoke.mjs'), 'utf8');
    const check = smoke.indexOf('await shippedFuseProblems(t.executable)');
    const unlock = smoke.indexOf('await allowInspectForTests(t.executable)');
    const e2e = smoke.indexOf("join(repo, 'scripts', 'e2e-electron.mjs'), '--packaged', t.executable");
    expect(check).toBeGreaterThan(0);
    expect(unlock).toBeGreaterThan(check);
    expect(e2e).toBeGreaterThan(unlock);
    expect(smoke).toMatch(/const ok = probeOk && fusesOk && e2e\.status === 0;/);
  });
});
