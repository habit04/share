import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { originFailureDiagnostics } from '../scripts/origin-failure-diagnostics.mjs';

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'jcad-origin-diagnostic-test-')); roots.push(root);
  const profile = join(root, 'profile'), output = join(root, 'artifacts'); mkdirSync(profile); mkdirSync(output);
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 123, exitCode: null, signalCode: null, killed: false });
  const page = Object.assign(new EventEmitter(), { url: () => 'about:blank', isClosed: () => false, mainFrame: () => ({}) });
  const app = Object.assign(new EventEmitter(), { process: () => child, windows: () => [page], evaluate: vi.fn(async () => ({ ready: true, windows: [] })) });
  return { root, profile, output, child, page, app, typedApp: app };
}
const silence = () => vi.spyOn(console, 'error').mockImplementation(() => {});

describe('failure-only origin diagnostics', () => {
  it('captures capped child tails and selected test values without dumping LevelDB or unrelated preferences', async () => {
    silence(); const f = fixture();
    writeFileSync(join(f.profile, 'renderer-preferences.json'), JSON.stringify({ 'jcad-origin-test': 'expected', 'unrelated-test-setting': 'DO_NOT_DUMP' }));
    writeFileSync(join(f.profile, 'renderer-origin-migrated'), '1');
    writeFileSync(join(f.profile, 'error.log'), 'a'.repeat(80_000) + 'LATEST_ERROR');
    mkdirSync(join(f.profile, 'Local Storage')); writeFileSync(join(f.profile, 'Local Storage', 'private-content'), 'DO_NOT_DUMP');
    const observed = originFailureDiagnostics(f.typedApp, { profile: f.profile, output: f.output, launch: 0 });
    f.child.stdout.emit('data', Buffer.from('x'.repeat(80_000) + 'LATEST_STDOUT'));
    f.child.stderr.emit('data', Buffer.from('y'.repeat(80_000) + 'LATEST_STDERR'));
    f.page.emit('crash');
    const original = new Error('secure window assertion'); await expect(observed.capture(original)).resolves.toBeUndefined(); observed.stop();
    expect(readdirSync(f.output)).toEqual(['origin-failure-launch-1.json']);
    const text = readFileSync(join(f.output, 'origin-failure-launch-1.json'), 'utf8'), proof = JSON.parse(text);
    expect(text).not.toContain('DO_NOT_DUMP'); expect(proof.failure).toContain(original.message);
    expect(proof.stdoutTail.length).toBeLessThanOrEqual(16_384); expect(proof.stdoutTail).toMatch(/LATEST_STDOUT$/);
    expect(proof.stderrTail.length).toBeLessThanOrEqual(16_384); expect(proof.stderrTail).toMatch(/LATEST_STDERR$/);
    expect(proof.profile.selected['error.log'].text).toHaveLength(16_384);
    expect(proof.profile.selected['error.log'].text).toMatch(/LATEST_ERROR$/);
    expect(proof.profile.selected['renderer-preferences.json'].testValues['jcad-origin-test']).toBe('expected');
    expect(proof.events.some((event: { kind: string }) => event.kind === 'page-crash')).toBe(true);
    expect(f.app.listenerCount('window')).toBe(0); expect(f.child.stdout.listenerCount('data')).toBe(0);
  });

  it('retains a report when main/window/process/profile details are unavailable and never rejects capture', async () => {
    silence(); const f = fixture();
    f.app.evaluate.mockRejectedValue(new Error('Main inspector disconnected'));
    f.app.process = () => { throw new Error('No child'); };
    f.app.windows = () => { throw new Error('Target list unavailable'); };
    const observed = originFailureDiagnostics(f.typedApp, { profile: join(f.root, 'absent'), output: f.output, launch: 1 });
    const original = new Error('ORIGINAL_FAILURE'); await expect(observed.capture(original)).resolves.toBeUndefined(); observed.stop();
    const proof = JSON.parse(readFileSync(join(f.output, 'origin-failure-launch-2.json'), 'utf8'));
    expect(proof.failure).toContain('ORIGINAL_FAILURE'); expect(proof.main.unavailable).toContain('disconnected');
    expect(proof.process.unavailable).toBe(true); expect(proof.profile.inventory[0].unavailable).toBeTruthy();
  });

  it('does not replace an existing artifact or propagate output failures over the original assertion', async () => {
    silence(); const f = fixture(); const filename = join(f.output, 'origin-failure-launch-1.json'); writeFileSync(filename, 'prior evidence');
    const observed = originFailureDiagnostics(f.typedApp, { profile: f.profile, output: f.output, launch: 0 });
    const original = new Error('original assertion'); let caught;
    try { try { throw original; } catch (error) { await observed.capture(error); throw error; } }
    catch (error) { caught = error; } finally { observed.stop(); }
    expect(caught).toBe(original); expect(readFileSync(filename, 'utf8')).toBe('prior evidence');
  });

  it('rejects traversal-shaped launch identifiers before any artifact is created', () => {
    const f = fixture();
    expect(() => originFailureDiagnostics(f.typedApp, { profile: f.profile, output: f.output, launch: '../escape' as unknown as number })).toThrow('Invalid origin diagnostic launch index');
    expect(readdirSync(f.output)).toEqual([]);
  });

  it('caps checkpoint parsing and records malformed JSON without replacing the failure', async () => {
    silence(); const f = fixture(); writeFileSync(join(f.profile, 'renderer-preferences.json'), '{invalid');
    const observed = originFailureDiagnostics(f.typedApp, { profile: f.profile, output: f.output, launch: 2 });
    await observed.capture(new Error('original')); observed.stop();
    const proof = JSON.parse(readFileSync(join(f.output, 'origin-failure-launch-3.json'), 'utf8'));
    expect(proof.profile.selected['renderer-preferences.json'].unavailable).toBeTruthy(); expect(proof.failure).toContain('original');
  });

  it('omits an oversized checkpoint without exposing its values', async () => {
    silence(); const f = fixture();
    writeFileSync(join(f.profile, 'renderer-preferences.json'), JSON.stringify({ private: 'DO_NOT_DUMP'.repeat(8_000) }));
    const observed = originFailureDiagnostics(f.typedApp, { profile: f.profile, output: f.output, launch: 0 });
    await observed.capture(new Error('original')); observed.stop();
    const text = readFileSync(join(f.output, 'origin-failure-launch-1.json'), 'utf8'), proof = JSON.parse(text);
    expect(text).not.toContain('DO_NOT_DUMP');
    expect(proof.profile.selected['renderer-preferences.json'].omitted).toContain('read cap');
  });

  it('records real CDP target data probed from the live page while its window exists', async () => {
    silence(); const f = fixture();
    const targetInfos = [
      { type: 'page', url: 'jcad://app/index.html', attached: true, targetId: 'MAIN-TARGET' },
      { type: 'page', url: 'file:///app/dist/index.html', attached: true, targetId: 'MIGRATION-TARGET' },
    ];
    const session = { send: vi.fn(async (method: string) => { if (method !== 'Target.getTargets') throw new Error(`Unexpected CDP method ${method}`); return { targetInfos }; }), detach: vi.fn(async () => {}) };
    const newCDPSession = vi.fn(async () => session);
    Object.assign(f.app, { context: () => ({ newCDPSession }) });
    const observed = originFailureDiagnostics(f.typedApp, { profile: f.profile, output: f.output, launch: 0 });
    // The probe runs off the window event (the fixture page is already open at
    // construction); let it land before the failure capture reads the snapshot.
    await new Promise((done) => setImmediate(done)); await new Promise((done) => setImmediate(done));
    await observed.capture(new Error('original')); observed.stop();
    expect(newCDPSession).toHaveBeenCalledExactlyOnceWith(f.page);
    expect(session.send).toHaveBeenCalledExactlyOnceWith('Target.getTargets');
    const proof = JSON.parse(readFileSync(join(f.output, 'origin-failure-launch-1.json'), 'utf8'));
    expect(proof.cdpTargets).toHaveLength(1);
    expect(proof.cdpTargets[0].pageUrl).toBe('about:blank');
    expect(typeof proof.cdpTargets[0].at).toBe('string');
    expect(proof.cdpTargets[0].targets).toEqual([
      { type: 'page', url: 'jcad://app/index.html', attached: true, targetId: 'MAIN-TARGET' },
      { type: 'page', url: 'file:///app/dist/index.html', attached: true, targetId: 'MIGRATION-TARGET' },
    ]);
  });

  it('keeps every window snapshot instead of overwriting the migration window with the main window', async () => {
    silence(); const f = fixture();
    const migrationPage = Object.assign(new EventEmitter(), { url: () => 'file:///app/dist/index.html', isClosed: () => false, mainFrame: () => ({}) });
    const sessions = new Map<unknown, { send: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn> }>();
    const sessionFor = (targets: unknown[]) => ({ send: vi.fn(async () => ({ targetInfos: targets })), detach: vi.fn(async () => {}) });
    sessions.set(f.page, sessionFor([{ type: 'page', url: 'file:///app/dist/index.html', attached: true, targetId: 'MIGRATION-TARGET' }]));
    sessions.set(migrationPage, sessionFor([
      { type: 'page', url: 'file:///app/dist/index.html', attached: true, targetId: 'MIGRATION-TARGET' },
      { type: 'page', url: 'jcad://app/index.html', attached: true, targetId: 'MAIN-TARGET' },
    ]));
    Object.assign(f.app, { context: () => ({ newCDPSession: vi.fn(async (page: unknown) => sessions.get(page)) }) });
    const observed = originFailureDiagnostics(f.typedApp, { profile: f.profile, output: f.output, launch: 0 });
    // A second window (the main window) appears after the migration window:
    // its probe must APPEND, not replace (round 3).
    f.app.emit('window', migrationPage);
    await new Promise((done) => setImmediate(done)); await new Promise((done) => setImmediate(done)); await new Promise((done) => setImmediate(done));
    await observed.capture(new Error('original')); observed.stop();
    const proof = JSON.parse(readFileSync(join(f.output, 'origin-failure-launch-1.json'), 'utf8'));
    expect(proof.cdpTargets).toHaveLength(2);
    expect(proof.cdpTargets[0].pageUrl).toBe('about:blank');
    expect(proof.cdpTargets[0].targets.map((t: { targetId: string }) => t.targetId)).toEqual(['MIGRATION-TARGET']);
    expect(proof.cdpTargets[1].pageUrl).toBe('file:///app/dist/index.html');
    expect(proof.cdpTargets[1].targets.map((t: { targetId: string }) => t.targetId)).toEqual(['MIGRATION-TARGET', 'MAIN-TARGET']);
  });

  it('bounds an unresponsive main snapshot and still records the original failure', async () => {
    silence(); vi.useFakeTimers(); const f = fixture();
    f.app.evaluate.mockImplementation(() => new Promise<never>(() => {}));
    const observed = originFailureDiagnostics(f.typedApp, { profile: f.profile, output: f.output, launch: 0 });
    const capture = observed.capture(new Error('ORIGINAL_FAILURE'));
    await vi.advanceTimersByTimeAsync(2_000); await capture; observed.stop();
    const proof = JSON.parse(readFileSync(join(f.output, 'origin-failure-launch-1.json'), 'utf8'));
    expect(proof.failure).toContain('ORIGINAL_FAILURE'); expect(proof.main.unavailable).toContain('2000ms');
    expect(f.app.evaluate).toHaveBeenCalledOnce();
  });
});
