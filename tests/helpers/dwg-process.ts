import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { serialize } from 'node:v8';

export type DwgResult = { payload: { entities: unknown[]; layers: unknown[]; blocks: unknown[]; [key: string]: unknown }; version: string };
export type DwgProcess = EventEmitter & { readonly pid: number | undefined; postMessage(message: any): void; kill(): void };
export type DwgMemoryGuard = { ready: Promise<void>; checkNow(): boolean; stop(): void };
export type DwgHostOptions = {
  scriptsDir: string;
  timeoutMs?: number;
  maxBytes?: number;
  resourceLimits?: Record<string, number>;
  launchProcess?: (modulePath: string, options: { env: NodeJS.ProcessEnv }) => DwgProcess;
  memoryGuardFactory?: (options: { pid: number; onFailure(error: Error): void }) => DwgMemoryGuard;
  allowTestHooks?: boolean;
};
export type DwgHost = {
  read(bytes: Uint8Array, id?: number): Promise<DwgResult>;
  cancel(id: number): boolean;
  dispose(): void;
  newId(): number;
  readonly usesWorker: boolean;
  readonly usesProcess: boolean;
};

const require = createRequire(import.meta.url);
export const { createDwgHost, OpenCancelledError, readTimeoutFor, WORKER_RESOURCE_LIMITS,
  MAX_OUTSTANDING_READS, MAX_QUEUED_BYTES } = require('../../electron/dwg-host.cjs') as {
  createDwgHost(options: DwgHostOptions): DwgHost;
  OpenCancelledError: new () => Error;
  readTimeoutFor(bytes: number): number;
  WORKER_RESOURCE_LIMITS: Record<string, number>;
  MAX_OUTSTANDING_READS: number;
  MAX_QUEUED_BYTES: number;
};

const liveChildren = new Set<{ kill(): void; closed: Promise<void> }>();

/** Explicit test transport. Production always uses Electron's utilityProcess. */
export function launchNodeProcess(modulePath: string, { env }: { env: NodeJS.ProcessEnv }): DwgProcess {
  const child = fork(modulePath, [], { env, serialization: 'advanced', execArgv: [], windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const events = new EventEmitter() as DwgProcess;
  Object.defineProperty(events, 'pid', { get: () => child.pid });
  events.postMessage = (message) => {
    child.send(message, (error) => { if (error) events.emit('error', error); });
    events.emit('sent', message);
  };
  events.kill = () => { child.kill('SIGKILL'); };
  const tracked = { kill: events.kill, closed: new Promise<void>((resolve) => {
    child.once('exit', () => { liveChildren.delete(tracked); resolve(); });
  }) };
  liveChildren.add(tracked);
  for (const name of ['spawn', 'message', 'exit', 'error']) child.on(name, (...args) => events.emit(name, ...args));
  return events;
}

/** OS memory sampling is tested independently and by the real Electron containment probe. */
export const unitMemoryGuard = (): DwgMemoryGuard => ({ ready: Promise.resolve(), checkNow: () => true, stop: () => {} });

export async function stopNodeChildren() {
  const children = [...liveChildren];
  for (const child of children) child.kill();
  await Promise.all(children.map((child) => child.closed));
}

/** Controllable utility API double for ordering and adversarial protocol tests. */
export class ControlledDwgProcess extends EventEmitter implements DwgProcess {
  readonly sent: any[] = [];
  killCalls = 0;
  exited = false;
  constructor(readonly pid: number, readonly autoExit = true) { super(); }
  postMessage(message: any) { this.sent.push(message); }
  kill() {
    this.killCalls += 1;
    if (this.autoExit) queueMicrotask(() => this.exit());
  }
  reply(message: any) { this.emit('message', message); }
  exit() {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', 0);
  }
  async start(ready = { type: 'ready', protocol: 1, pid: this.pid }) {
    this.emit('spawn');
    this.reply(ready);
    await Promise.resolve();
  }
  acceptInput() {
    const start = this.sent.find((message) => message.type === 'input-start');
    if (!start) throw new Error('Test process has not received input-start.');
    this.reply({ type: 'input-ack', id: start.id, offset: 0 });
    let at = this.sent.length - 1;
    while (this.sent[at]?.type === 'input-chunk') {
      const chunk = this.sent[at];
      this.reply({ type: 'input-ack', id: start.id, offset: chunk.offset + chunk.bytes.byteLength });
      at += 1;
    }
    if (this.sent[at]?.type !== 'input-end') throw new Error('Test process did not receive all input bytes.');
    return start;
  }
  respond(result: DwgResult, id = this.sent.find((message) => message.type === 'input-start')?.id) {
    const bytes = serialize(result);
    this.reply({ type: 'output-start', id, byteLength: bytes.byteLength });
    for (let offset = 0; offset < bytes.byteLength; offset += 1024 * 1024) {
      this.reply({ type: 'output-chunk', id, offset, bytes: Uint8Array.from(bytes.subarray(offset, offset + 1024 * 1024)) });
    }
    this.reply({ type: 'done', id });
  }
}

export function controlledLauncher(autoExit = true) {
  const children: ControlledDwgProcess[] = [];
  const launchProcess = () => {
    const child = new ControlledDwgProcess(100_000 + children.length, autoExit);
    children.push(child);
    return child;
  };
  return { children, launchProcess };
}
