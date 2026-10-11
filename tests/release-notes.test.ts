import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProvenance, releaseNotes, sectionFor } from '../scripts/release-notes.mjs';
import { signingSummary } from '../scripts/release-provenance.mjs';

// scripts/release-notes.mjs: the GitHub release body is the tag's CHANGELOG.md section.

const changelog = `# Changelog

## [Unreleased]

### Added

- Next thing.

## [0.2.0] - 2026-11-01

### Fixed

- A bug.

## [0.1.0] - 2026-10-20

- First.

[0.2.0]: https://github.com/habit04/share/compare/v0.1.0...v0.2.0
`;

describe('release notes from CHANGELOG.md', () => {
  it('takes the section of the version, up to the next heading or link list', () => {
    expect(sectionFor(changelog, 'v0.2.0')).toBe('### Fixed\n\n- A bug.');
    expect(sectionFor(changelog, '0.1.0')).toBe('- First.');
    expect(sectionFor(changelog, 'Unreleased')).toBe('### Added\n\n- Next thing.');
    expect(sectionFor(changelog, '9.9.9')).toBeNull();
    // "0.1" is not "0.1.0".
    expect(sectionFor(changelog, 'v0.1')).toBeNull();
  });

  it('falls back to Unreleased and adds the download footer', () => {
    const n = releaseNotes(changelog, 'v0.3.0');
    expect(n).toContain('- Next thing.');
    expect(n).toContain('jcad-electrical-0.3.0-win-x64.exe');
    expect(n).toContain('jcad-electrical-0.3.0-mac-arm64.dmg');
    expect(n).toContain('https://habit04.github.io/share/');
    expect(n).toContain('https://github.com/habit04/share/blob/v0.3.0/CHANGELOG.md');
    expect(n).toContain('Signing varies by release');
    expect(n).toContain('unsigned Windows and all Linux/macOS builds use manual installation');
    expect(n).toContain('install a verified update only after you choose Restart Now');
    expect(n).not.toContain('macOS builds are not notarized');
  });

  it('says how a macOS build opens from the signing status the build recorded', () => {
    const footer = (macSigning?: string) => releaseNotes(changelog, 'v0.3.0', undefined, { macSigning }).split('\n').find((l) => l.startsWith('First launch:'));
    // Developer ID signed and notarized (0.4.2 on): no Privacy & Security step.
    expect(footer('developer-id-notarized')).toContain('macOS builds are signed with a Developer ID and notarized by Apple');
    expect(footer('developer-id-notarized')).not.toMatch(/Open Anyway|not notarized/);
    // Ad-hoc (no Apple secrets; every release up to 0.4.1): Open Anyway once.
    expect(footer('ad-hoc')).toContain('macOS builds are not notarized and open once through System Settings > Privacy & Security > Open Anyway.');
    // Not known: a sentence that is true of either build, and no claim about this one.
    expect(footer()).toContain('a macOS build that is not notarized opens once');
    expect(footer()).not.toContain('macOS builds are');
    for (const f of [footer('developer-id-notarized'), footer('ad-hoc'), footer()]) expect(f).toContain('Windows SmartScreen may say');
    expect(() => releaseNotes(changelog, 'v0.3.0', undefined, { macSigning: 'notarized' })).toThrow(/unknown macOS signing status/);
  });

  it('reads the macOS signing status from the build record or the release record (scripts/release-provenance.mjs)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jcad-notes-'));
    try {
      expect(readProvenance(join(dir, 'missing'))).toBeNull();
      expect(readProvenance(dir)).toBeNull();
      // The release job's downloaded artifacts: one folder per platform with its build record.
      mkdirSync(join(dir, 'JCad-Electrical-macOS'));
      mkdirSync(join(dir, 'JCad-Electrical-Linux'));
      writeFileSync(join(dir, 'JCad-Electrical-Linux', 'JCad-Electrical-Linux-provenance.json'), JSON.stringify({ platform: 'Linux', signing: 'unsigned' }));
      writeFileSync(join(dir, 'JCad-Electrical-macOS', 'JCad-Electrical-macOS-provenance.json'), JSON.stringify({ platform: 'macOS', signing: 'ad-hoc' }));
      expect(readProvenance(dir)).toEqual({ macSigning: 'ad-hoc', release: null });
      // A release's published record: the status, and the record whose Verified build list goes into the notes.
      const release = { schemaVersion: 1, version: '0.4.2', sourceSha: 'a'.repeat(40), builds: [{ platform: 'Windows', signing: 'authenticode-verified' }, { platform: 'macOS', signing: 'developer-id-notarized' }, { platform: 'Linux', signing: 'unsigned' }] };
      const file = join(dir, 'release-provenance.json');
      writeFileSync(file, JSON.stringify(release));
      expect(readProvenance(file)).toEqual({ macSigning: 'developer-id-notarized', release });
      expect(readProvenance(dir)?.macSigning).toBe('developer-id-notarized');
      expect(signingSummary(release)).toContain('- macOS: Developer ID signature, hardened runtime and notarization verified.');
      writeFileSync(file, JSON.stringify({ ...release, builds: [{ platform: 'macOS', signing: 'unsigned' }] }));
      expect(() => readProvenance(file)).toThrow(/no macOS build with a known signing status/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('produces the notes of the current version from the real changelog, and the notes kept in docs/releases', () => {
    const real = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    // The release workflow runs with --strict: the version being released has its own section.
    const section = sectionFor(real, pkg.version);
    expect(section).not.toBeNull();
    const n = releaseNotes(real, `v${pkg.version}`);
    expect(n.startsWith(`${section}\n`)).toBe(true);
    expect(n).toMatch(/^### /m);
    expect(n).not.toMatch(/^## \[/m);
    // docs/releases/v0.4.0.md is exactly what the script makes for v0.4.0 (pasted into that release;
    // its macOS builds were ad-hoc signed). The newer snapshots use the Developer ID/notarized
    // publication policy (the release page adds the actual Verified build list after its gates).
    // Normalize checkout line endings while keeping both snapshots otherwise exact.
    const signing = { 'v0.4.0': 'ad-hoc', 'v0.4.2': 'developer-id-notarized', 'v0.4.3': 'developer-id-notarized' };
    for (const [tag, macSigning] of Object.entries(signing)) {
      expect(readFileSync(new URL(`../docs/releases/${tag}.md`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')).toBe(releaseNotes(real, tag, undefined, { macSigning }));
    }
    // Upgrade notes first (0.4.1's update dialog shows the first 600 characters), the footer last.
    const v042 = releaseNotes(real, 'v0.4.2', undefined, { macSigning: 'developer-id-notarized' });
    expect(v042.startsWith('### Upgrade notes\n')).toBe(true);
    expect(v042).not.toContain('Open Anyway');
    const current = releaseNotes(real, `v${pkg.version}`, undefined, { macSigning: 'developer-id-notarized' });
    expect(current.startsWith('### Upgrade notes\n')).toBe(true);
    expect(current).toContain(`jcad-electrical-${pkg.version}-win-x64.exe`);
    expect(current).not.toContain('Open Anyway');
  });
});
