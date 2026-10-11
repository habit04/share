import { describe, it, expect } from 'vitest';
import { diagnosticsText, reportText, issueUrl, redactLocalPaths, type ReportInput } from '../src/app/diagnostics';

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
    for (const s of ['Wire numbers skip rung 103', 'Version: 0.3.0', 'win32 x64', 'Drawing: [drawing name omitted]', 'Every rung numbered.', 'at x.ts:1']) expect(r).toContain(s);
    expect(reportText({ ...base, includePrivateDetails: true })).toContain('Drawing: Drawing1.dxf');
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
  // Security review E-16, ported from PR #2 (codex/electrical-review-fixes 2f89b0e).
  it('redacts local paths before sharing and keeps them only with the explicit opt-in', () => {
    const privateInput = { ...base, history: ['OPEN C:\\Customers\\Confidential\\panel.dxf', 'OPEN /home/justin/customer/panel.dxf', 'XREF \\\\fileserver\\jobs\\acme\\site.dwg'], errors: [{ time: 0, kind: 'error' as const, message: "ENOSPC: no space left on device, write '/Users/ann/Plant 7/panel.dxf'" }] };
    const url = issueUrl(privateInput);
    for (const secret of ['Confidential', 'justin', 'customer', 'fileserver', 'acme', 'ann', 'Plant 7']) expect(decodeURIComponent(url), secret).not.toContain(secret);
    expect(new URL(url).searchParams.get('diagnostics')).toContain('OPEN [local path]');
    expect(reportText(privateInput)).not.toContain('Drawing1.dxf');
    expect(reportText(privateInput)).toContain("write '[local path]'");
    expect(diagnosticsText({ ...privateInput, includePrivateDetails: true })).toContain('Confidential');
  });
  it('redactLocalPaths leaves web links, versions and relative names alone', () => {
    for (const keep of ['see https://github.com/habit04/share/issues/12', 'Version 0.4.1 on win32 x64', 'OPEN panel.dxf', 'ratio 1:2/3', 'http://example.com/home/x']) expect(redactLocalPaths(keep)).toBe(keep);
    expect(redactLocalPaths('file:///C:/jobs/a.dxf and D:/b.dxf')).toBe('[local path]');
    expect(redactLocalPaths('at "C:\\x\\y.dxf" and /tmp/z.dxf')).toBe('at "[local path]" and [local path]');
  });
  it('removable media and network mounts carry the user name too (Linux /run/media/<user>, GNOME /run/user/<id>/gvfs, macOS /Network)', () => {
    expect(redactLocalPaths('Opened /run/media/bob/USB/plant.dxf')).toBe('Opened [local path]');
    expect(redactLocalPaths("save '/run/user/1000/gvfs/smb-share:server=nas,share=jobs/a.dxf'")).toBe("save '[local path]'");
    expect(redactLocalPaths('/net/fileserver/jobs/a.dxf and /Network/Servers/nas/a.dxf')).toBe('[local path]');
  });
  it('redaction is linear in the text', () => {
    const t = performance.now();
    redactLocalPaths(`${'\\\\a'.repeat(200_000)} ${'C:'.repeat(200_000)} ${'/home'.repeat(200_000)}`);
    expect(performance.now() - t).toBeLessThan(2000);
  });
  it('falls back to the first line of the description as the title', () => {
    expect(new URL(issueUrl({ ...base, title: '' })).searchParams.get('title')).toBe('[Bug] Ran AEWIRENO; rung 103 got no number.');
  });
});
