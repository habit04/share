/** Portable writer boundaries, integrity, destination protection, and acknowledged cancellation. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
type RunOptions = { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number; spawn?: (...args: unknown[]) => unknown; stopTimeoutMs?: number; checkLimits?: () => Promise<void>; limitIntervalMs?: number };
type Run = (exe: string, args: string[], options: RunOptions) => Promise<string>;
type Locations = { directory: string; manifest: string };
type ConvertOptions = { fs?: typeof fs; locations?: () => Locations; temporaryRoot?: string; signal?: AbortSignal; run?: Run };
type Commit = (file: string, data: Buffer, check: () => Promise<void>) => Promise<void>;
type Exporter = { status(): Promise<{ available: boolean; reason?: string }>; export(file: string, text: string, commit: Commit, signal?: AbortSignal): Promise<string> };
const host = require('../electron/portable-dwg.cjs') as {
  convertDxfToDwg(text: string, options: ConvertOptions): Promise<Buffer>;
  createPortableDwgExporter(options: { platform?: string; locations?: () => Locations; convert?: (text: string, options: ConvertOptions) => Promise<Buffer> }): Exporter;
  verifyPortableWriter(locations: Locations): Promise<{ executable: string; check(): Promise<void> }>;
  validateExportDxf(text: unknown): void;
  writerTimeout(bytes: number): number;
  writerEnvironment(workspace: string, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  verifyWriterReport(report: Buffer, output: Buffer): unknown;
};
const { runBoundedWriter } = require('../electron/portable-dwg-process.cjs') as { runBoundedWriter: Run };

const roots: string[] = [];
const DXF = '0\r\nSECTION\r\n2\r\nHEADER\r\n0\r\nENDSEC\r\n0\r\nEOF\r\n';
const OUTPUT = Buffer.concat([Buffer.from('AC1032'), Buffer.alloc(130, 1)]);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const report = (patch: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({ schemaVersion: 1, success: true, outputFormat: 'AC1032', outputSha256: sha256(OUTPUT), warnings: [], errors: [], processMemoryLimitBytes: 1073741824, inputEntityCount: 2, outputEntityCount: 2, ...patch }));

afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    // Recursively remove only fresh test directories directly inside the known temporary root.
    expect(path.dirname(path.resolve(root))).toBe(path.resolve(tmpdir()));
    expect(path.basename(root)).toMatch(/^jcad-portable-dwg-test-/);
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'jcad-portable-dwg-test-'));
  roots.push(root);
  const directory = path.join(root, 'helper');
  await fs.mkdir(directory);
  const executable = path.join(directory, 'JcadDwgWriter.exe');
  const bytes = Buffer.from('trusted native fixture');
  await fs.writeFile(executable, bytes);
  const manifest = path.join(directory, 'integrity.json');
  const manifestValue = { schemaVersion: 1, files: [{ name: 'JcadDwgWriter.exe', size: bytes.length, sha256: sha256(bytes) }] };
  await fs.writeFile(manifest, JSON.stringify(manifestValue));
  const locations = () => ({ directory, manifest });
  const target = path.join(root, 'drawing.dwg');
  return { root, directory, executable, manifest, manifestValue, locations, target };
}

function fakeChild() {
  const child = Object.assign(new EventEmitter(), { pid: 42, exitCode: null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(() => true) });
  const launch = vi.fn(() => child);
  return { child, launch };
}

describe('bounded portable writer process', () => {
  it('uses argument arrays without a shell and combines bounded diagnostics only after close', async () => {
    const { child, launch } = fakeChild();
    const pending = runBoundedWriter('trusted.exe', ['convert', 'input.dxf', 'output.dwg', 'report.json'], { cwd: '/private', spawn: launch });
    expect(launch).toHaveBeenCalledWith('trusted.exe', ['convert', 'input.dxf', 'output.dwg', 'report.json'], expect.objectContaining({ shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: '/private' }));
    child.stdout.emit('data', Buffer.from('first'));
    child.stderr.emit('data', Buffer.from('second'));
    child.emit('close', 0, null);
    expect(await pending).toBe('firstsecond');
  });

  it('stops excessive output and waits for acknowledged process close before rejecting', async () => {
    const { child, launch } = fakeChild();
    let settled = false;
    const pending = runBoundedWriter('trusted.exe', [], { spawn: launch, maxBytes: 4 });
    void pending.then(() => { settled = true; }, () => { settled = true; });
    child.stdout.emit('data', Buffer.from('too much'));
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(settled).toBe(false);
    child.emit('close', null, 'SIGKILL');
    await expect(pending).rejects.toThrow(/too much diagnostic/);
  });

  it('times out without releasing the request before the writer exits', async () => {
    vi.useFakeTimers();
    const { child, launch } = fakeChild();
    const pending = runBoundedWriter('trusted.exe', [], { spawn: launch, timeoutMs: 100 });
    let settled = false;
    void pending.catch(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    child.emit('close', null, 'SIGKILL');
    await expect(pending).rejects.toThrow(/timed out/);
  });

  it('reports an unacknowledged stop distinctly so the host closes later admission', async () => {
    vi.useFakeTimers();
    const { launch } = fakeChild();
    const pending = runBoundedWriter('trusted.exe', [], { spawn: launch, timeoutMs: 100, stopTimeoutMs: 20 });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'DWG_STOP_UNCONFIRMED' });
    await vi.advanceTimersByTimeAsync(120);
    await rejected;
  });

  it('cancels on caller abort and waits for close', async () => {
    const { child, launch } = fakeChild();
    const controller = new AbortController();
    const pending = runBoundedWriter('trusted.exe', [], { spawn: launch, signal: controller.signal });
    controller.abort();
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit('close', null, 'SIGKILL');
    await expect(pending).rejects.toThrow(/canceled/);
  });

  it('treats an error after spawn as a request to stop, rather than evidence the child exited', async () => {
    const { child, launch } = fakeChild();
    const pending = runBoundedWriter('trusted.exe', [], { spawn: launch });
    child.emit('error', new Error('late process error'));
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit('close', 1, null);
    await expect(pending).rejects.toThrow(/late process error/);
  });

  it('rejects a failed spawn directly and refuses to launch an already canceled request', async () => {
    const { child, launch } = fakeChild();
    const pending = runBoundedWriter('trusted.exe', [], { spawn: launch });
    Object.assign(child, { pid: undefined });
    child.emit('error', new Error('ENOENT'));
    await expect(pending).rejects.toThrow('ENOENT');
    const controller = new AbortController();
    controller.abort();
    launch.mockClear();
    await expect(runBoundedWriter('trusted.exe', [], { spawn: launch, signal: controller.signal })).rejects.toThrow(/canceled/);
    expect(launch).not.toHaveBeenCalled();
  });

  it('terminates the writer when periodic output size monitoring fails', async () => {
    vi.useFakeTimers();
    const { child, launch } = fakeChild();
    const pending = runBoundedWriter('trusted.exe', [], { spawn: launch, limitIntervalMs: 10, checkLimits: async () => { throw new Error('oversized output'); } });
    await vi.advanceTimersByTimeAsync(10);
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit('close', null, 'SIGKILL');
    await expect(pending).rejects.toThrow(/oversized output/);
  });
});

describe('portable DWG helper integrity and protocol', () => {
  it('shows bounded refusal details only after an acknowledged writer exit', async () => {
    const f = await fixture();
    const options = { locations: f.locations, temporaryRoot: f.root };
    const run: Run = async (_exe, _args, opts) => {
      await fs.writeFile(path.join(opts.cwd!, 'report.json'), JSON.stringify({ schemaVersion: 1, success: false, outputFormat: 'AC1032', errors: ['Cannot preserve retained REGION objects.\nSave DXF.'] }));
      throw Object.assign(new Error('process failed'), { code: 'DWG_WRITER_EXIT' });
    };
    await expect(host.convertDxfToDwg(DXF, { ...options, run })).rejects.toThrow('DWG export refused: Cannot preserve retained REGION objects. Save DXF. The destination was not changed.');
    for (const errors of [[], ['x'.repeat(2001)], [123]]) {
      const malformed: Run = async (_exe, _args, opts) => {
        await fs.writeFile(path.join(opts.cwd!, 'report.json'), JSON.stringify({ schemaVersion: 1, success: false, outputFormat: 'AC1032', errors }));
        throw Object.assign(new Error('process failed'), { code: 'DWG_WRITER_EXIT' });
      };
      await expect(host.convertDxfToDwg(DXF, { ...options, run: malformed })).rejects.toThrow('process failed');
    }
    const unconfirmed: Run = async (_exe, _args, opts) => {
      await fs.writeFile(path.join(opts.cwd!, 'report.json'), JSON.stringify({ schemaVersion: 1, success: false, outputFormat: 'AC1032', errors: ['untrusted stop message'] }));
      throw Object.assign(new Error('stop unconfirmed'), { code: 'DWG_STOP_UNCONFIRMED' });
    };
    await expect(host.convertDxfToDwg(DXF, { ...options, run: unconfirmed })).rejects.toMatchObject({ code: 'DWG_STOP_UNCONFIRMED', message: 'stop unconfirmed' });
  });
  it('sanitizes runtime injection and uses a private temporary directory', () => {
    const env = host.writerEnvironment('/private/workspace', {
      PATH: '/normal/bin', SystemRoot: 'C:\\Windows', DOTNET_STARTUP_HOOKS: 'evil.dll', CORECLR_PROFILER_PATH: 'evil.dll',
      coreclr_enable_profiling: '1', COMPlus_GCHeapHardLimit: 'ffffffff', COR_PROFILER: 'evil', NODE_OPTIONS: '--require=evil', LD_PRELOAD: 'evil.so',
    });
    expect(env.PATH).toBe('/normal/bin');
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.DOTNET_STARTUP_HOOKS).toBeUndefined();
    expect(env.CORECLR_PROFILER_PATH).toBeUndefined();
    expect(env.coreclr_enable_profiling).toBeUndefined();
    expect(env.COMPlus_GCHeapHardLimit).toBeUndefined();
    expect(env.COR_PROFILER).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.DOTNET_GCHeapHardLimit).toBeUndefined();
    expect(env.TMP).toBe('/private/workspace');
    expect(env.TEMP).toBe('/private/workspace');
  });
  it('rejects non-DXF, incomplete, NUL-bearing and oversized input and bounds the deadline', () => {
    for (const text of [undefined, {}, 'not a DXF', '0\nSECTION\n', `${DXF}\0`]) expect(() => host.validateExportDxf(text)).toThrow();
    expect(() => host.validateExportDxf('é'.repeat(64 * 1024 * 1024 + 1))).toThrow(/size limit/);
    expect(() => host.validateExportDxf(DXF)).not.toThrow();
    expect(host.writerTimeout(0)).toBe(60_000);
    expect(host.writerTimeout(1024 * 1024)).toBe(61_000);
    expect(host.writerTimeout(128 * 1024 * 1024)).toBe(188_000);
  });

  it('verifies the trusted helper and refuses a changed binary before execution', async () => {
    const f = await fixture();
    const checked = await host.verifyPortableWriter(f.locations());
    expect(checked.executable).toBe(f.executable);
    await fs.writeFile(f.executable, Buffer.from('untrusted native file'));
    await expect(checked.check()).rejects.toThrow(/changed/);
    await expect(host.verifyPortableWriter(f.locations())).rejects.toThrow(/integrity/);
  });

  it('rehashes metadata changes while still refusing same-size changed bytes', async () => {
    const f = await fixture();
    const checked = await host.verifyPortableWriter(f.locations());
    const original = await fs.readFile(f.executable);
    await fs.utimes(f.executable, new Date('2025-01-01'), new Date('2025-01-01'));
    await expect(checked.check()).resolves.toBeUndefined();
    const changed = Buffer.from(original);
    changed[0] = changed[0]! ^ 1;
    await fs.writeFile(f.executable, changed);
    await fs.utimes(f.executable, new Date('2025-01-01'), new Date('2025-01-01'));
    await expect(checked.check()).rejects.toThrow(/changed after its integrity check/);
  });

  it('refuses a replacement file even when it has the exact trusted bytes', async () => {
    const f = await fixture();
    const checked = await host.verifyPortableWriter(f.locations());
    const original = await fs.readFile(f.executable);
    await fs.rename(f.executable, path.join(f.directory, 'old.exe'));
    await fs.writeFile(f.executable, original);
    await expect(checked.check()).rejects.toThrow(/changed after its integrity check/);
  });

  it('refuses mismatched hashes, directory traversal, duplicate Windows names, and unlisted dependencies', async () => {
    const f = await fixture();
    const item = f.manifestValue.files[0]!;
    for (const files of [[{ ...item, sha256: '0'.repeat(64) }], [{ ...item, name: '../evil.exe' }], [item, { ...item, name: 'jCADDWGWRITER.EXE' }]]) {
      await fs.writeFile(f.manifest, JSON.stringify({ schemaVersion: 1, files }));
      await expect(host.verifyPortableWriter(f.locations())).rejects.toThrow(/integrity|manifest/);
    }
    await fs.writeFile(f.manifest, JSON.stringify(f.manifestValue));
    await fs.writeFile(path.join(f.directory, 'unverified.dll'), 'unverified');
    await expect(host.verifyPortableWriter(f.locations())).rejects.toThrow(/unverified file/);
  });

  it('requires a successful AC1032 report with exactly matching output bytes and no warnings', () => {
    expect(() => host.verifyWriterReport(report(), OUTPUT)).not.toThrow();
    for (const patch of [{ success: false }, { outputFormat: 'AC1015' }, { outputSha256: '0'.repeat(64) }, { warnings: ['unknown dropped property'] }, { errors: ['failure'] }, { warnings: undefined }, { processMemoryLimitBytes: undefined }, { processMemoryLimitBytes: 0 }, { inputEntityCount: 250001 }, { outputEntityCount: 1 }]) {
      expect(() => host.verifyWriterReport(report(patch), OUTPUT)).toThrow();
    }
    expect(() => host.verifyWriterReport(Buffer.from('not json'), OUTPUT)).toThrow(/invalid verification report/);
    expect(() => host.verifyWriterReport(report(), Buffer.from('AC1032'))).toThrow();
  });

  it('runs only the verified executable with private ASCII filenames, validates output, and removes its workspace', async () => {
    const f = await fixture();
    let workspace = '';
    const run: Run = async (exe, args, opts) => {
      expect(exe).toBe(f.executable);
      expect(args).toEqual(['convert', 'input.dxf', 'output.dwg', 'report.json']);
      expect(opts.timeoutMs).toBe(61_000);
      expect(opts.env?.TMP).toBe(opts.cwd);
      workspace = opts.cwd!;
      expect(await fs.readFile(path.join(workspace, 'input.dxf'), 'utf8')).toBe(DXF);
      await fs.writeFile(path.join(workspace, 'output.dwg'), OUTPUT);
      await fs.writeFile(path.join(workspace, 'report.json'), report());
      return 'done';
    };
    expect(await host.convertDxfToDwg(DXF, { locations: f.locations, temporaryRoot: f.root, run })).toEqual(OUTPUT);
    await expect(fs.access(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['warning', 'oversized-report', 'bad-header'] as const)('does not accept incomplete helper output: %s', async (fault) => {
    const f = await fixture();
    const run: Run = async (_exe, _args, opts) => {
      const output = fault === 'bad-header' ? Buffer.alloc(136) : OUTPUT;
      await fs.writeFile(path.join(opts.cwd!, 'output.dwg'), output);
      await fs.writeFile(path.join(opts.cwd!, 'report.json'), fault === 'oversized-report' ? Buffer.alloc(1024 * 1024 + 1) : report(fault === 'warning' ? { warnings: ['unsupported'] } : {}));
      return 'done';
    };
    await expect(host.convertDxfToDwg(DXF, { locations: f.locations, temporaryRoot: f.root, run })).rejects.toThrow(/size limit|unsupported|verification report/);
    expect((await fs.readdir(f.root)).filter((name) => name.startsWith('jcad-dwg-'))).toEqual([]);
  });
});

describe('portable DWG export destination and admission', () => {
  it('preserves the original and refuses another program changing it while conversion runs', async () => {
    const f = await fixture();
    await fs.writeFile(f.target, 'original');
    const commit = vi.fn();
    const exporter = host.createPortableDwgExporter({ platform: 'win32', convert: async () => { await fs.writeFile(f.target, 'external edit'); return OUTPUT; } });
    await expect(exporter.export(f.target, DXF, commit)).rejects.toThrow(/destination DWG changed/);
    expect(commit).not.toHaveBeenCalled();
    expect(await fs.readFile(f.target, 'utf8')).toBe('external edit');
  });

  it('rejects concurrent exports and releases admission after acknowledged success', async () => {
    const f = await fixture();
    let release!: (value: Buffer) => void;
    const gate = new Promise<Buffer>((r) => { release = r; });
    const convert = vi.fn(async () => gate);
    const exporter = host.createPortableDwgExporter({ platform: 'win32', convert });
    const first = exporter.export(f.target, DXF, async () => {});
    await vi.waitFor(() => expect(convert).toHaveBeenCalledTimes(1));
    await expect(exporter.export(path.join(f.root, 'other.dwg'), DXF, async () => {})).rejects.toThrow(/already running/);
    release(OUTPUT);
    expect(await first).toBe(f.target);
    expect(await exporter.export(f.target, DXF, async () => {})).toBe(f.target);
  });

  it('fails later exports closed after an unacknowledged writer stop', async () => {
    const f = await fixture();
    const convert = vi.fn(async () => { throw Object.assign(new Error('could not be stopped'), { code: 'DWG_STOP_UNCONFIRMED' }); });
    const exporter = host.createPortableDwgExporter({ platform: 'win32', convert });
    await expect(exporter.export(f.target, DXF, async () => {})).rejects.toMatchObject({ code: 'DWG_STOP_UNCONFIRMED' });
    await expect(exporter.export(f.target, DXF, async () => {})).rejects.toThrow(/Restart JCad/);
    expect(await exporter.status()).toMatchObject({ available: false, reason: expect.stringMatching(/Restart JCad/) });
    expect(convert).toHaveBeenCalledTimes(1);
  });

  it('checks cancellation again inside the final commit and keeps originals untouched', async () => {
    const f = await fixture();
    await fs.writeFile(f.target, 'original');
    const controller = new AbortController();
    const exporter = host.createPortableDwgExporter({ platform: 'win32', convert: async () => OUTPUT });
    const commit: Commit = async (_file, _data, check) => { controller.abort(); await check(); };
    await expect(exporter.export(f.target, DXF, commit, controller.signal)).rejects.toThrow(/canceled/);
    expect(await fs.readFile(f.target, 'utf8')).toBe('original');
  });

  it('rejects non-Windows editions, invalid destinations, and reports missing helper availability', async () => {
    const f = await fixture();
    const linux = host.createPortableDwgExporter({ platform: 'linux' });
    expect(await linux.status()).toMatchObject({ available: false });
    await expect(linux.export(f.target, DXF, async () => {})).rejects.toThrow(/Windows desktop/);
    const exporter = host.createPortableDwgExporter({ platform: 'win32', locations: () => ({ directory: path.join(f.root, 'missing'), manifest: f.manifest }) });
    expect(await exporter.status()).toMatchObject({ available: false, reason: expect.stringMatching(/integrity check/) });
    for (const target of ['relative.dwg', path.join(f.root, 'wrong.dxf'), `${f.target}\0`]) await expect(exporter.export(target, DXF, async () => {})).rejects.toThrow(/Invalid DWG export destination/);
  });
});
