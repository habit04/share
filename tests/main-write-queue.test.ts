import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
type Options = { backup?: boolean; root?: string; expectedDestination?: string };
type Writer = {
  atomicWriteFile(file: string, data: string, opts?: Options): Promise<unknown>;
  canonicalWriteKey(file: string): Promise<string>;
};
const atomic = require('../electron/atomic-write.cjs') as {
  createAtomicWriter(fs?: unknown, options?: { hooks?: { beforeRename(tmp: string): void } }): Writer;
  createCanonicalWriteQueue(resolveKey?: (file: string) => Promise<string>): <T>(file: string, job: (key: string) => Promise<T>) => Promise<T>;
};
const source = readFileSync(new URL('../electron/main/app-data.cjs', import.meta.url), 'utf8');
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

/** Load the actual app-data module with Electron stubbed and injectable writer/key timing. */
function userWriter(writer: Writer, resolve: (file: string) => Promise<string>, write = writer.atomicWriteFile) {
  const module = { exports: {} as { writeUserFile(file: string, data: string, opts?: Options): Promise<unknown> } };
  new Function('require', 'module', source)((name: string) => {
    if (name === 'electron') return { app: { getPath: () => dir } };
    if (name === '../atomic-write.cjs') return {
      atomicWriteFile: write,
      createCanonicalWriteQueue: () => atomic.createCanonicalWriteQueue(resolve),
    };
    return require(name);
  }, module);
  return module.exports.writeUserFile;
}

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jcad-write-queue-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
function aliases() {
  const real = join(dir, 'real');
  const linked = join(dir, 'linked');
  mkdirSync(real);
  symlinkSync(real, linked, 'junction');
  return { real, linked, target: join(real, 'drawing.dxf'), alias: join(linked, 'drawing.dxf') };
}

describe('main-process canonical user-file queues', () => {
  it('real/junction aliases reserve in invocation order despite reversed resolution, and write serially', async () => {
    const { real, target, alias } = aliases();
    writeFileSync(target, 'ORIGINAL');
    const writer = atomic.createAtomicWriter(fsp);
    const firstLookup = deferred();
    const firstWrite = deferred();
    const firstStarted = deferred();
    const secondResolved = deferred();
    let lookups = 0;
    const order: string[] = [];
    const write = userWriter(writer, async (file) => {
      const number = ++lookups;
      if (number === 1) await firstLookup.promise;
      const key = await writer.canonicalWriteKey(file);
      if (number === 2) secondResolved.release();
      return key;
    }, async (file, data, opts) => {
      order.push(data);
      if (data === 'FIRST') { firstStarted.release(); await firstWrite.promise; }
      return writer.atomicWriteFile(file, data, opts);
    });
    const first = write(alias, 'FIRST', { backup: true, root: dir });
    const second = write(target, 'SECOND', { backup: true, root: dir });
    await secondResolved.promise;
    expect(order).toEqual([]); // the later key did not enter its queue first
    firstLookup.release();
    await firstStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(['FIRST']);
    firstWrite.release();
    await Promise.all([first, second]);
    expect(order).toEqual(['FIRST', 'SECOND']);
    expect(readFileSync(target, 'utf8')).toBe('SECOND');
    expect(readFileSync(`${target}.bak`, 'utf8')).toBe('FIRST');
    expect(readdirSync(real).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('a failed alias write cleans its temp and does not block later writes or reservations', async () => {
    const { real, target, alias } = aliases();
    writeFileSync(target, 'ORIGINAL');
    const writer = atomic.createAtomicWriter(fsp, { hooks: { beforeRename(tmp) {
      if (readFileSync(tmp, 'utf8') === 'FAIL') throw Object.assign(new Error('simulated write failure'), { code: 'EIO' });
    } } });
    const write = userWriter(writer, writer.canonicalWriteKey);
    const failed = write(alias, 'FAIL');
    const assertion = expect(failed).rejects.toMatchObject({ code: 'EIO', path: alias });
    const recovered = write(target, 'RECOVERED');
    await Promise.all([assertion, recovered]);
    expect(readFileSync(target, 'utf8')).toBe('RECOVERED');
    expect(readdirSync(real).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    await write(alias, 'LATER');
    expect(readFileSync(target, 'utf8')).toBe('LATER');
    expect(readdirSync(real).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('a failed canonical lookup does not block a later alias save', async () => {
    const { target, alias } = aliases();
    let failures = 1;
    const writer = atomic.createAtomicWriter({ ...fsp, realpath: async (file: string) => {
      if (failures-- > 0) throw Object.assign(new Error('lookup denied'), { code: 'EACCES' });
      return fsp.realpath(file);
    } });
    const write = userWriter(writer, writer.canonicalWriteKey);
    const failed = write(alias, 'FAIL');
    const assertion = expect(failed).rejects.toMatchObject({ code: 'EACCES', path: alias });
    const next = write(target, 'NEXT');
    await Promise.all([assertion, next]);
    expect(readFileSync(target, 'utf8')).toBe('NEXT');
  });

  it('an unrelated destination can finish while an earlier write remains pending', async () => {
    const firstFile = join(dir, 'first.dxf');
    const otherFile = join(dir, 'other.dxf');
    const hold = deferred();
    const started = deferred();
    const writer = atomic.createAtomicWriter(fsp);
    const write = userWriter(writer, writer.canonicalWriteKey, async (file, data, opts) => {
      if (file === firstFile) { started.release(); await hold.promise; }
      return writer.atomicWriteFile(file, data, opts);
    });
    const first = write(firstFile, 'FIRST');
    await started.promise;
    try {
      await write(otherFile, 'OTHER');
      expect(readFileSync(otherFile, 'utf8')).toBe('OTHER');
      expect(readdirSync(dir)).not.toContain('first.dxf');
    } finally {
      hold.release();
      await first;
    }
  });

  it('an alias retargeted while queued cannot write a different physical destination', async () => {
    const { target, alias, linked } = aliases();
    const other = join(dir, 'other');
    mkdirSync(other);
    writeFileSync(join(other, 'drawing.dxf'), 'UNRELATED');
    const writer = atomic.createAtomicWriter(fsp);
    const hold = deferred();
    const started = deferred();
    const secondResolved = deferred();
    let lookups = 0;
    const write = userWriter(writer, async (file) => {
      const key = await writer.canonicalWriteKey(file);
      if (++lookups === 2) secondResolved.release();
      return key;
    }, async (file, data, opts) => {
      if (data === 'FIRST') { started.release(); await hold.promise; }
      return writer.atomicWriteFile(file, data, opts);
    });
    const first = write(target, 'FIRST', { root: dir });
    await started.promise;
    const second = write(alias, 'SECOND', { root: dir });
    const assertion = expect(second).rejects.toMatchObject({ code: 'ELOOP', path: alias });
    await secondResolved.promise;
    await fsp.unlink(linked);
    symlinkSync(other, linked, 'junction');
    hold.release();
    await Promise.all([first, assertion]);
    expect(readFileSync(target, 'utf8')).toBe('FIRST');
    expect(readFileSync(join(other, 'drawing.dxf'), 'utf8')).toBe('UNRELATED');
  });
});
