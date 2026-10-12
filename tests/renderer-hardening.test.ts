/**
 * Security review E-15: renderer and package hardening that CI cannot exercise without building
 * installers. The page's Content-Security-Policy, developer tools only in development runs, and
 * the Electron fuses the installers ship with (package.json build.electronFuses): RunAsNode,
 * NODE_OPTIONS and --inspect off, the application only from app.asar. The packaged smoke test
 * verifies every shipping installer without changing its signed executable. Playwright uses a
 * separate unpublished test ASAR. The read-only fuse helpers are tested on small files carrying
 * the same fuse wire as Electron binaries.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { SHIPPED_FUSES, shippedFuseProblems, shipsFuses } from '../scripts/electron-fuses.mjs';
import { verifyExecutableFuses } from '../scripts/electron-fuse-policy.mjs';
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
    type Item = { role?: string; submenu?: Item[] };
    for (const isPackaged of [false, true]) {
      let items: Item[] = [];
      const module = { exports: {} as { buildMenu: (win: unknown, ctx: unknown) => void } };
      runInNewContext(readSource('electron/main/menu.cjs'), {
        module,
        require: (name: string) => {
          if (name === 'electron') return {
            app: { isPackaged, getVersion: () => '0.4.2' }, BrowserWindow: {},
            Menu: { buildFromTemplate: (template: Item[]) => template, setApplicationMenu: (template: Item[]) => { items = template; } },
          };
          if (name === 'node:path') return path;
          if (name === '../updater.cjs') return {};
          if (name === '../path-registry.cjs') return { pathKey: () => null };
          throw new Error(`Unexpected menu dependency: ${name}`);
        },
      });
      module.exports.buildMenu({ webContents: { send: () => {} } }, { registry: {}, handedOverProjects: new Set() });
      const roles = items.flatMap((item) => item.submenu ?? []).filter((item) => item.role === 'toggleDevTools');
      expect(roles).toHaveLength(isPackaged ? 0 : 1);
    }
  });
});

describe('Electron fuses (package.json build.electronFuses, scripts/electron-fuses.mjs)', () => {
  it('the build switches off RunAsNode, NODE_OPTIONS and --inspect and loads the app from app.asar only', () => {
    expect(pkg.build.electronFuses).toEqual({ ...SHIPPED_FUSES, resetAdHocDarwinSignature: true });
    expect(SHIPPED_FUSES).toEqual({ runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false, enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true, grantFileProtocolExtraPrivileges: false });
  });

  it('shippedFuseProblems reads the wire: none for a build as shipped, each wrong fuse named otherwise', async () => {
    const shipped = fakeBinary([OFF, ON, OFF, OFF, ON, ON, OFF, OFF]);
    expect(await shippedFuseProblems(shipped)).toEqual([]);
    const options: [number, string][] = [[0, 'RunAsNode'], [2, 'EnableNodeOptionsEnvironmentVariable'], [3, 'EnableNodeCliInspectArguments'], [4, 'EnableEmbeddedAsarIntegrityValidation'], [5, 'OnlyLoadAppFromAsar'], [7, 'GrantFileProtocolExtraPrivileges']];
    for (const [index, name] of options) {
      const states = [OFF, ON, OFF, OFF, ON, ON, OFF, OFF];
      states[index] = states[index] === ON ? OFF : ON;
      expect(await shippedFuseProblems(fakeBinary(states))).toEqual([expect.stringContaining(name)]);
    }
    expect(await shippedFuseProblems(join(dir, 'missing'))).toHaveLength(1);
  });

  it('shipping validation leaves bytes untouched and the separate test policy permits inspection only', async () => {
    const shipped = fakeBinary([OFF, ON, OFF, OFF, ON, ON, OFF, OFF]);
    const original = readFileSync(shipped);
    await verifyExecutableFuses(shipped, 'shipping');
    expect(readFileSync(shipped)).toEqual(original);
    const test = fakeBinary([OFF, ON, OFF, ON, ON, ON, OFF, OFF]);
    await verifyExecutableFuses(test, 'test');
    await expect(verifyExecutableFuses(test, 'shipping')).rejects.toThrow(/EnableNodeCliInspectArguments/);
    await expect(verifyExecutableFuses(shipped, 'test')).rejects.toThrow(/EnableNodeCliInspectArguments/);
  });

  it('installers from the release after 0.4.1 ship the fuses; older ones are not checked', () => {
    expect(shipsFuses('0.4.1')).toBe(false);
    expect(shipsFuses('v0.4.0')).toBe(false);
    for (const v of ['0.4.2', '0.5.0', '1.0.0', 'v0.4.2-beta.1']) expect(shipsFuses(v), v).toBe(true);
    expect(() => shipsFuses('latest')).toThrow(/Invalid version/);
  });

  it('the packaged smoke test verifies shipping fuses before fixed probes and never unlocks inspection', () => {
    const smoke = readFileSync(join(root, 'scripts', 'packaged-smoke.mjs'), 'utf8');
    const check = smoke.indexOf("await verifyExecutableFuses(t.executable, 'shipping')");
    const runtime = smoke.indexOf("join(repo, 'scripts', 'shipping-runtime-smoke.mjs')");
    expect(check).toBeGreaterThan(0);
    expect(runtime).toBeGreaterThan(check);
    expect(smoke).not.toMatch(/allowInspectForTests|flipFuses/);
    expect(smoke).toContain("JCAD_SMOKE_REQUIRE_SHIPPING === '1'");
    expect(smoke).toContain('const ok = probeOk && childSucceeded(runtime);');
  });
});
