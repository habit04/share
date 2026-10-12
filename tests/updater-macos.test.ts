/**
 * The macOS minimum of a release (0.4.2 needs macOS 13; 0.4.1 ran on macOS 11 and 12).
 *
 * macOS copies learn about a release through the GitHub API (electron/updater.cjs checkViaApi),
 * not electron-updater, and electron-builder 26 writes package.json build.mac.minimumSystemVersion
 * only into the application's Info.plist. The macOS build therefore writes it into the release's
 * latest-mac.yml (scripts/mac-update-info.mjs) and the updater does not offer the download to a Mac
 * with an older system. 0.4.1 cannot know: the release notes say it first, in the part its update
 * dialog shows.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withMinimumSystemVersion, macMinimumOf } from '../scripts/mac-update-info.mjs';
import { releaseNotes } from '../scripts/release-notes.mjs';

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, '..');
const version = require('../electron/version.cjs') as { minimumSystemVersionFrom(text: string): string | null; systemOlderThan(system: string, minimum: string | null): boolean };
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

describe('the minimum macOS version of a release', () => {
  it('retains the macOS 13 requirement and legacy feed tools while new Mac releases are paused', () => {
    expect(macMinimumOf(pkg)).toBe('13.0');
    expect(() => macMinimumOf({ build: { mac: {} } })).toThrow(/minimumSystemVersion is not set/);
    const yml = "version: 0.4.2\r\nfiles:\r\n  - url: jcad-electrical-0.4.2-mac-arm64.dmg\r\n    sha512: abc\r\npath: jcad-electrical-0.4.2-mac-arm64.dmg\r\nsha512: abc\r\nreleaseDate: '2026-10-12T00:00:00.000Z'\r\n";
    const out = withMinimumSystemVersion(yml, '13.0');
    expect(out.split('\n').slice(0, 2)).toEqual(['version: 0.4.2', "minimumSystemVersion: '13.0'"]);
    expect(withMinimumSystemVersion(out, '14.1')).not.toContain("'13.0'"); // replaced, not repeated
    expect(version.minimumSystemVersionFrom(out)).toBe('13.0');
    expect(() => withMinimumSystemVersion('files: []', '13.0')).toThrow(/no version/);
    expect(() => withMinimumSystemVersion(yml, '13; rm')).toThrow(/invalid macOS version/);
    const wf = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(wf).not.toContain('node scripts/mac-update-info.mjs release');
    expect(wf).not.toContain('os: macos-');
    expect(wf).toContain('--policy windows-only');
  });

  it('reads the minimum and compares dotted versions part by part', () => {
    expect(version.minimumSystemVersionFrom("version: 1\nminimumSystemVersion: '13.0'\n")).toBe('13.0');
    expect(version.minimumSystemVersionFrom('minimumSystemVersion: 13.5.1')).toBe('13.5.1');
    expect(version.minimumSystemVersionFrom('version: 0.4.1\nfiles: []\n')).toBeNull();
    expect(version.minimumSystemVersionFrom('minimumSystemVersion: thirteen')).toBeNull();
    expect(version.systemOlderThan('12.7.4', '13.0')).toBe(true);
    expect(version.systemOlderThan('11.7.10', '13.0')).toBe(true);
    expect(version.systemOlderThan('13.0', '13.0')).toBe(false);
    expect(version.systemOlderThan('13.6.1', '13.0')).toBe(false);
    expect(version.systemOlderThan('15.1', '13.0')).toBe(false);
    expect(version.systemOlderThan('10.15.7', '11')).toBe(true);
    expect(version.systemOlderThan('', '13.0')).toBe(false); // unknown: nothing withheld
    expect(version.systemOlderThan('12.7', null)).toBe(false);
  });

  it('the release notes say it before anything else (0.4.1 shows their first 600 characters in its update dialog)', () => {
    const notes = releaseNotes(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), 'v0.4.2');
    const shown = notes.slice(0, 600);
    expect(shown).toContain('macOS 13 Ventura or later is required');
    expect(shown).toContain('keep JCad Electrical 0.4.1');
    expect(shown).toContain('https://github.com/habit04/share/releases/tag/v0.4.1');
  });
});

// ---------------------------------------------------------------- the updater with stand-ins for Electron

type Box = { title?: string; message?: string; detail?: string; buttons?: string[]; cancelId?: number };
type Updater = { checkForUpdates(win: unknown, opts?: { interactive?: boolean }): Promise<{ state: string; version?: string; message?: string }>; onStatus(fn: (s: { state: string; message?: string }) => void): void };
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const proc = process as NodeJS.Process & { getSystemVersion?: () => string };
afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  delete proc.getSystemVersion;
});

/** updater.cjs loaded against stand-ins: GitHub answers with `release` and the assets in `files`. */
function updaterOn(system: string, release: unknown, files: Record<string, string | Error>, answer = 'Later') {
  Object.defineProperty(process, 'platform', { ...realPlatform, value: 'darwin' });
  proc.getSystemVersion = () => system;
  const boxes: Box[] = [];
  const fetched: string[] = [];
  const opened: string[] = [];
  const electron = {
    app: { isPackaged: false, getVersion: () => '0.4.2' },
    dialog: {
      showMessageBox: async (_w: unknown, o: Box) => {
        boxes.push(o);
        const i = (o.buttons ?? []).indexOf(answer);
        return { response: i >= 0 ? i : (o.cancelId ?? 0) }; // a button that is not there: the dialog is closed
      },
    },
    shell: { openExternal: async (u: string) => void opened.push(u) },
    net: {
      fetch: async (u: string) => {
        fetched.push(u);
        if (u.startsWith('https://api.github.com/')) return new Response(JSON.stringify(release), { status: 200 });
        const f = files[u];
        if (f instanceof Error) throw f;
        return f === undefined ? new Response('', { status: 404 }) : new Response(f, { status: 200 });
      },
    },
  };
  const electronPath = require.resolve('electron');
  const updaterPath = require.resolve('../electron/updater.cjs');
  const saved = require.cache[electronPath];
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electron } as unknown as NodeJS.Module;
  delete require.cache[updaterPath];
  try {
    const updater = require(updaterPath) as Updater;
    const states: Array<{ state: string; message?: string }> = [];
    updater.onStatus((s) => states.push(s));
    return { updater, boxes, fetched, opened, states };
  } finally {
    if (saved) require.cache[electronPath] = saved;
    else delete require.cache[electronPath];
    delete require.cache[updaterPath];
  }
}

const base = 'https://github.com/habit04/share/releases/download/v0.5.0';
const release = (assets: Array<{ name: string; browser_download_url: string }>) => ({ tag_name: 'v0.5.0', html_url: 'https://github.com/habit04/share/releases/tag/v0.5.0', body: 'Notes', assets });
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const dmg = { name: `jcad-electrical-0.5.0-mac-${arch}.dmg`, browser_download_url: `${base}/jcad-electrical-0.5.0-mac-${arch}.dmg` };
const feed = { name: 'latest-mac.yml', browser_download_url: `${base}/latest-mac.yml` };
const yml14 = "version: 0.5.0\nminimumSystemVersion: '14.0'\nfiles: []\n";

describe('Check for Updates on macOS (electron/updater.cjs)', () => {
  it('a Mac older than the release needs is told so, and offered no download', async () => {
    const t = updaterOn('13.6.1', release([dmg, feed]), { [feed.browser_download_url]: yml14 }, 'Download');
    const r = await t.updater.checkForUpdates({}, { interactive: true });
    expect(r).toEqual({ state: 'unsupported', version: '0.5.0', message: 'JCad Electrical 0.5.0 needs macOS 14.0 or later; this Mac runs macOS 13.6.1, so 0.4.2 stays the version for it.' });
    expect(t.fetched).toEqual(['https://api.github.com/repos/habit04/share/releases/latest', feed.browser_download_url]);
    expect(t.boxes).toHaveLength(1);
    expect(t.boxes[0]).toMatchObject({ message: 'JCad Electrical 0.5.0 needs macOS 14.0 or later.', buttons: ['Release Notes', 'Close'] });
    expect(t.opened).toEqual([]); // no "Download" button to press
    expect(t.states.map((s) => s.state)).toEqual(['checking', 'unsupported']);
    // The silent start-up check says nothing in a dialog.
    const quiet = updaterOn('12.7.4', release([dmg, feed]), { [feed.browser_download_url]: yml14 });
    expect((await quiet.updater.checkForUpdates({}, { interactive: false })).state).toBe('unsupported');
    expect(quiet.boxes).toEqual([]);
  });

  it('a Mac new enough, a release without a minimum (0.4.1 and older) or an unreadable feed: the download is offered as before', async () => {
    for (const [system, files, assets] of [
      ['14.0', { [feed.browser_download_url]: yml14 }, [dmg, feed]],
      ['12.7.4', { [feed.browser_download_url]: 'version: 0.5.0\nfiles: []\n' }, [dmg, feed]],
      ['12.7.4', { [feed.browser_download_url]: new Error('ENOTFOUND') }, [dmg, feed]],
      ['12.7.4', {}, [dmg]],
    ] as const) {
      const t = updaterOn(system, release([...assets]), files as Record<string, string | Error>, 'Download');
      const r = await t.updater.checkForUpdates({}, { interactive: true });
      expect(r, system).toEqual({ state: 'available', version: '0.5.0' });
      expect(t.boxes[0]?.buttons).toEqual(['Download', 'Release Notes', 'Later']);
      expect(t.opened).toEqual([dmg.browser_download_url]);
    }
  });

  it('the Update Available text fits a notarized build and an ad-hoc one alike (no Open Anyway step promised)', async () => {
    const t = updaterOn('14.0', release([dmg, feed]), { [feed.browser_download_url]: yml14 });
    expect((await t.updater.checkForUpdates({}, { interactive: true })).state).toBe('available');
    expect(t.boxes[0]).toMatchObject({ title: 'Update Available', message: 'JCad Electrical 0.5.0 is available (you have 0.4.2).' });
    expect(t.boxes[0]?.detail).toBe(
      'Download the new disk image and drag the app to Applications to replace this one. If macOS blocks the first launch, allow it once in System Settings > Privacy & Security.\n\nNotes',
    );
    expect(t.boxes[0]?.detail).not.toContain('Open Anyway');
  });

  it("the feed is read only from this project's release downloads", async () => {
    const elsewhere = { name: 'latest-mac.yml', browser_download_url: 'https://example.com/habit04/share/releases/download/v0.5.0/latest-mac.yml' };
    const t = updaterOn('12.7.4', release([dmg, elsewhere]), { [elsewhere.browser_download_url]: yml14 });
    expect((await t.updater.checkForUpdates({}, { interactive: false })).state).toBe('available');
    expect(t.fetched).toEqual(['https://api.github.com/repos/habit04/share/releases/latest']);
  });

  it('other systems are not asked (the minimum is a macOS version)', async () => {
    const t = updaterOn('12.7.4', release([dmg, feed]), { [feed.browser_download_url]: yml14 });
    Object.defineProperty(process, 'platform', realPlatform);
    if (process.platform === 'darwin') return;
    expect((await t.updater.checkForUpdates({}, { interactive: false })).state).toBe('available');
    expect(t.fetched).toEqual(['https://api.github.com/repos/habit04/share/releases/latest']);
  });
});
