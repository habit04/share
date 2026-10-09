import { describe, it, expect } from 'vitest';
import {
  isInstaller,
  snapshotFromReleases,
  countsOf,
  diffCounts,
  totalOf,
  parseState,
  renderBody,
  renderComment,
  compareTags,
  TRACKER_LABEL,
} from '../scripts/download-alerts.mjs';

const releases = [
  {
    tag_name: 'v0.4.0',
    draft: false,
    assets: [
      { name: 'jcad-electrical-0.4.0-win-x64.exe', download_count: 3, browser_download_url: 'https://example.test/v0.4.0/win.exe' },
      { name: 'jcad-electrical-0.4.0-win-x64.exe.blockmap', download_count: 40 },
      { name: 'jcad-electrical-0.4.0-mac-arm64.dmg', download_count: 0 },
      { name: 'latest.yml', download_count: 999 },
      { name: 'latest-mac.yml', download_count: 999 },
    ],
  },
  {
    tag_name: 'v0.3.1',
    draft: false,
    assets: [{ name: 'jcad-electrical-0.3.1-mac-arm64.dmg', download_count: 7 }],
  },
  { tag_name: 'v9.9.9', draft: true, assets: [{ name: 'draft.exe', download_count: 5 }] },
];

describe('download alerts: counters', () => {
  it('ignores updater metadata and block maps', () => {
    expect(isInstaller('jcad-electrical-0.4.0-win-x64.exe')).toBe(true);
    expect(isInstaller('jcad-electrical-0.4.0-mac-arm64.dmg')).toBe(true);
    expect(isInstaller('jcad-electrical-0.4.0-linux-x86_64.AppImage')).toBe(true);
    expect(isInstaller('jcad-electrical-0.4.0-win-x64.exe.blockmap')).toBe(false);
    expect(isInstaller('latest.yml')).toBe(false);
    expect(isInstaller('latest-mac.yml')).toBe(false);
    expect(isInstaller('SHA256SUMS.txt')).toBe(false);
  });

  it('flattens releases into installer counters and skips drafts', () => {
    const snap = snapshotFromReleases(releases);
    expect(Object.keys(snap).sort()).toEqual([
      'v0.3.1/jcad-electrical-0.3.1-mac-arm64.dmg',
      'v0.4.0/jcad-electrical-0.4.0-mac-arm64.dmg',
      'v0.4.0/jcad-electrical-0.4.0-win-x64.exe',
    ]);
    expect(snap['v0.4.0/jcad-electrical-0.4.0-win-x64.exe']).toMatchObject({ tag: 'v0.4.0', count: 3, url: 'https://example.test/v0.4.0/win.exe' });
    expect(totalOf(snap)).toBe(10);
    expect(countsOf(snap)).toEqual({
      'v0.3.1/jcad-electrical-0.3.1-mac-arm64.dmg': 7,
      'v0.4.0/jcad-electrical-0.4.0-mac-arm64.dmg': 0,
      'v0.4.0/jcad-electrical-0.4.0-win-x64.exe': 3,
    });
  });

  it('reports only counters that went up, newest release first', () => {
    const snap = snapshotFromReleases(releases);
    const prev = {
      'v0.3.1/jcad-electrical-0.3.1-mac-arm64.dmg': 5, // +2
      'v0.4.0/jcad-electrical-0.4.0-mac-arm64.dmg': 0, // unchanged
      'v0.4.0/jcad-electrical-0.4.0-win-x64.exe': 4, // went down (asset re-uploaded): ignored
      'v0.2.0/jcad-electrical-0.2.0-win-x64.exe': 9, // release deleted: ignored
    };
    expect(diffCounts(prev, snap)).toEqual([
      { key: 'v0.3.1/jcad-electrical-0.3.1-mac-arm64.dmg', tag: 'v0.3.1', name: 'jcad-electrical-0.3.1-mac-arm64.dmg', before: 5, after: 7, delta: 2 },
    ]);
    // A release that is new since the last run counts from zero; a new one with no downloads is silent.
    const fresh = diffCounts({}, snap);
    expect(fresh.map((c) => `${c.tag}:${c.delta}`)).toEqual(['v0.4.0:3', 'v0.3.1:7']);
    expect(diffCounts(countsOf(snap), snap)).toEqual([]);
  });

  it('orders version tags numerically', () => {
    expect(['v0.3.4', 'v0.10.0', 'v0.4.0', 'v0.3.10'].sort((a, b) => compareTags(b, a))).toEqual(['v0.10.0', 'v0.4.0', 'v0.3.10', 'v0.3.4']);
    expect(compareTags('beta', 'alpha')).toBeGreaterThan(0);
  });
});

describe('download alerts: tracker issue', () => {
  it('round-trips the hidden state through the issue body', () => {
    const snap = snapshotFromReleases(releases);
    const body = renderBody(snap, '2026-10-09T13:00:00.000Z');
    expect(body).toContain('| v0.4.0 | jcad-electrical-0.4.0-win-x64.exe | 3 |');
    expect(body).toContain('All-time installer downloads: **10**');
    expect(body.indexOf('| v0.4.0 |')).toBeLessThan(body.indexOf('| v0.3.1 |'));
    const state = parseState(body);
    expect(state).toEqual({ updated: '2026-10-09T13:00:00.000Z', counts: countsOf(snap) });
    // Text the owner adds around the hidden block does not break it.
    expect(parseState('Hello\n\n' + body + '\n\nmore notes')).toEqual(state);
  });

  it('treats a missing or damaged state block as absent', () => {
    expect(parseState('')).toBeNull();
    expect(parseState(undefined as unknown as string)).toBeNull();
    expect(parseState('<!-- download-state not json -->')).toBeNull();
    expect(parseState('<!-- download-state {"updated":"x"} -->')).toBeNull();
    expect(parseState('<!-- download-state {"counts":{"a/b":1}} -->')).toEqual({ counts: { 'a/b': 1 }, updated: null });
  });

  it('writes a readable alert comment with links and totals', () => {
    const snap = snapshotFromReleases(releases);
    const changes = diffCounts({}, snap);
    const comment = renderComment(changes, snap, '2026-10-09T12:00:00.000Z', '2026-10-09T13:00:00.000Z');
    expect(comment).toContain('**10 new downloads** since 2026-10-09T12:00:00.000Z');
    expect(comment).toContain('- v0.4.0 · [jcad-electrical-0.4.0-win-x64.exe](https://example.test/v0.4.0/win.exe): +3 (now 3)');
    expect(comment).toContain('- v0.3.1 · jcad-electrical-0.3.1-mac-arm64.dmg: +7 (now 7)');
    expect(comment).toContain('All-time installer downloads: 10.');
    const one = renderComment(changes.slice(0, 1), snap, null, '2026-10-09T13:00:00.000Z');
    expect(one).toContain('**3 new downloads** since the last check');
    expect(renderComment([{ key: 'k', tag: 'v1', name: 'a.exe', before: 0, after: 1, delta: 1 }], {}, null, 'now')).toContain('**1 new download**');
  });

  it('uses a dedicated label so the issue watch can skip it', () => {
    expect(TRACKER_LABEL).toBe('download-tracker');
  });
});
