import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { releaseNotes, sectionFor } from '../scripts/release-notes.mjs';

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
    expect(n).not.toContain('macOS builds are not notarized');
  });

  it('produces the notes of the current version from the real changelog, and the 0.4.0 notes kept in docs/releases', () => {
    const real = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    // The release workflow runs with --strict: the version being released has its own section.
    expect(sectionFor(real, pkg.version)).not.toBeNull();
    const n = releaseNotes(real, `v${pkg.version}`);
    expect(n).toContain('### Fixed');
    expect(n).not.toMatch(/^## \[/m);
    // docs/releases/v0.4.0.md is exactly what the script makes for v0.4.0 (pasted into that release).
    expect(readFileSync(new URL('../docs/releases/v0.4.0.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n')).toBe(releaseNotes(real, 'v0.4.0'));
  });
});
