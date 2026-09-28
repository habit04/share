import { describe, it, expect } from 'vitest';
import { diagnosticsText, reportText, issueUrl, type ReportInput } from '../src/app/diagnostics';

const base: ReportInput = {
  title: 'Wire numbers skip rung 103',
  happened: 'Ran AEWIRENO; rung 103 got no number.',
  expected: 'Every rung numbered.',
  steps: '1. Open demo\n2. AEWIRENO',
  version: '0.3.0',
  platform: 'win32',
  arch: 'x64',
  history: Array.from({ length: 100 }, (_, i) => `Command: ${i}`),
  errors: [{ time: Date.UTC(2026, 8, 28, 1, 2, 3), kind: 'error', message: 'boom\n  at x.ts:1' }],
  drawingName: 'Drawing1.dxf',
  extra: ['Symbol standard: JIC'],
};

describe('problem reports', () => {
  it('lists only the most recent history and the first line of each error', () => {
    const t = diagnosticsText(base, 10);
    expect(t).toContain('Command: 99');
    expect(t).not.toContain('Command: 89');
    expect(t).toContain('error: boom');
    expect(t).not.toContain('at x.ts');
    expect(t).toContain('Symbol standard: JIC');
  });
  it('writes a complete plain-text report with the full stack of recent errors', () => {
    const r = reportText(base);
    for (const s of ['Wire numbers skip rung 103', 'Version: 0.3.0', 'win32 x64', 'Drawing: Drawing1.dxf', 'Every rung numbered.', 'at x.ts:1']) expect(r).toContain(s);
  });
  it('prefills the GitHub issue form and keeps the URL short', () => {
    const u = new URL(issueUrl(base));
    expect(u.origin + u.pathname).toBe('https://github.com/habit04/share/issues/new');
    expect(u.searchParams.get('template')).toBe('bug_report.yml');
    expect(u.searchParams.get('title')).toBe('[Bug] Wire numbers skip rung 103');
    expect(u.searchParams.get('version')).toBe('0.3.0, win32 x64');
    expect(u.searchParams.get('diagnostics')).toContain('Command: 99');
    const huge = { ...base, errors: Array.from({ length: 60 }, (_, i) => ({ time: 0, kind: 'error' as const, message: 'x'.repeat(1500) + i })) };
    expect(issueUrl(huge).length).toBeLessThan(9000);
    expect(new URL(issueUrl(huge)).searchParams.get('diagnostics')).toContain('truncated');
  });
  it('falls back to the first line of the description as the title', () => {
    expect(new URL(issueUrl({ ...base, title: '' })).searchParams.get('title')).toBe('[Bug] Ran AEWIRENO; rung 103 got no number.');
  });
});
