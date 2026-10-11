import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import { configureWindowsAzureSigning } from '../scripts/azure-signing.mjs';

const require = createRequire(import.meta.url);
const { validateConfiguration } = require('app-builder-lib/out/util/config/config.js');
const { WindowsSignAzureManager } = require('app-builder-lib/out/codeSign/windowsSignAzureManager.js');
const { getAppUpdatePublishConfiguration } = require('app-builder-lib/out/publish/PublishManager.js');
const { Platform } = require('app-builder-lib');
const { Arch } = require('builder-util');
const { installationHasTrustedPublisher } = require('../electron/update-policy.cjs');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const debugLogger = { isEnabled: false };
// Schema-only options: no authentication values, signing initialization or service calls.
const signing = { publisherName: 'JCad Test Publisher', endpoint: 'https://example.invalid', codeSigningAccountName: 'schema-test', certificateProfileName: 'schema-test' };

describe('Azure signing configuration supported by the installed builder', () => {
  it('validates the real release configuration and removes the obsolete Windows field', async () => {
    const input = { ...pkg.build.win, publisherName: 'obsolete publisher' };
    const win = configureWindowsAzureSigning(input, signing);
    expect(win).not.toHaveProperty('publisherName');
    expect(win.azureSignOptions?.publisherName).toBe(signing.publisherName);
    expect(win.target).toEqual(pkg.build.win.target);
    expect(input.publisherName).toBe('obsolete publisher');
    await expect(validateConfiguration({ ...pkg.build, win }, debugLogger)).resolves.toBeUndefined();
    await expect(validateConfiguration({ ...pkg.build, win: { ...win, publisherName: signing.publisherName } }, debugLogger)).rejects.toThrow(/configuration\.win/);
  });

  it('keeps the publisher in the builder-generated update configuration and updater trust check', async () => {
    const win = configureWindowsAzureSigning(pkg.build.win, signing);
    const manager = new WindowsSignAzureManager({
      platformSpecificBuildOptions: win,
      get vm() { throw new Error('This test must not initialize or contact Azure signing'); },
    });
    const packager = {
      platform: Platform.WINDOWS,
      platformSpecificBuildOptions: win,
      config: pkg.build,
      info: { config: pkg.build, appInfo: { channel: null } },
      appInfo: { updaterCacheDirName: 'jcad-test-updater' },
      expandMacro: (value: string) => value,
      isForceCodeSigningVerification: true,
      signingManager: { value: Promise.resolve(manager) },
    };
    const update = await getAppUpdatePublishConfiguration(packager, null, Arch.x64, false);
    expect(update.publisherName).toEqual([signing.publisherName]);
    const resources = mkdtempSync(join(tmpdir(), 'jcad-update-publisher-'));
    if (!resources.startsWith(join(tmpdir(), 'jcad-update-publisher-'))) throw new Error('Unexpected test directory');
    try {
      writeFileSync(join(resources, 'app-update.yml'), dump(update));
      expect(installationHasTrustedPublisher(resources)).toBe(true);
      writeFileSync(join(resources, 'app-update.yml'), dump({ ...update, publisherName: [] }));
      expect(installationHasTrustedPublisher(resources)).toBe(false);
    } finally {
      rmSync(resources, { recursive: true, force: true });
    }
  });
});
