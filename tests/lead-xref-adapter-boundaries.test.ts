/** Independent P20.2 adapter-boundary repros; fake bridge only, no filesystem or Electron. */
import { describe, expect, it } from 'vitest';
import { createXrefReader, type XrefBrokerBridge, type XrefReaderSession } from '../src/app/xref-reader';
import type { XrefFileIdentity, XrefReadContext } from '../src/io/xref-loading';

const HOST = 'C:\\private-xref-test\\host.dxf';
const LEAF = 'C:\\private-xref-test\\leaf.dxf';
const SESSION: XrefReaderSession = { docId: 'boundary-doc', contentGeneration: 1, hostPath: HOST };
const NEXT_SESSION: XrefReaderSession = { ...SESSION, contentGeneration: 2 };
const context = (): XrefReadContext => ({ resolvedPath: LEAF, originalPath: 'leaf.dxf', blockName: 'LEAF', depth: 1, maxBytes: 4096 });
type Stage = 'begin' | 'identify' | 'read';
type Retire = 'setSession' | 'dispose';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Every operation is also observed immediately; this protects a released fake gate itself.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };
const observe = (operation: Promise<unknown>): Promise<Outcome> => operation.then(
  value => ({ ok: true, value }), error => ({ ok: false, error }),
);
function failure(outcome: Outcome): Error & { code?: string } {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error('Expected the adapter operation to reject');
  expect(outcome.error).toBeInstanceOf(Error);
  return outcome.error as Error & { code?: string };
}

class Bridge implements XrefBrokerBridge {
  calls: Array<{ method: Stage | 'cancel' | 'close'; token?: string; ticket?: string; info?: unknown }> = [];
  nextToken = 0;
  gate: { stage: Stage; entered: ReturnType<typeof deferred<void>>; completion: ReturnType<typeof deferred<void>> } | null = null;
  rejection: { stage: Stage; error: Error } | null = null;
  hold(stage: Stage) {
    if (this.gate) throw new Error('One owned deferred bridge call at a time');
    const gate = { stage, entered: deferred<void>(), completion: deferred<void>() };
    this.gate = gate;
    return gate;
  }
  private async boundary(stage: Stage) {
    const gate = this.gate;
    if (gate?.stage === stage) {
      this.gate = null;
      gate.entered.resolve();
      await gate.completion.promise;
    }
    if (this.rejection?.stage === stage) throw this.rejection.error;
  }
  async beginXrefContext(info: Parameters<XrefBrokerBridge['beginXrefContext']>[0]) {
    const token = `context-${++this.nextToken}`;
    this.calls.push({ method: 'begin', token, info });
    await this.boundary('begin');
    return { token };
  }
  async identifyXref(token: string, _path: string) {
    this.calls.push({ method: 'identify', token });
    await this.boundary('identify');
    return { ticket: `${token}:ticket`, identity: { id: `identity:${token}`, owningLocation: LEAF, version: `version:${token}` } satisfies XrefFileIdentity };
  }
  async readXref(token: string, ticket: string, _maxBytes: number) {
    this.calls.push({ method: 'read', token, ticket });
    await this.boundary('read');
    if (ticket !== `${token}:ticket`) throw new Error('ERR_XREF_CONTEXT: ticket belongs to another context');
    return { text: 'owned fake xref text', byteLength: 20, version: `version:${token}` };
  }
  async cancelXref(token: string) { this.calls.push({ method: 'cancel', token }); return true; }
  async closeXrefContext(token: string) { this.calls.push({ method: 'close', token }); return true; }
}

describe('lead review: retired rejected bridge completions must remain cancellation', () => {
  for (const stage of ['begin', 'identify', 'read'] as const) {
    for (const retire of ['setSession', 'dispose'] as const) {
      it(`${stage} rejection after ${retire} is AbortError, with no continuation in the new session`, async () => {
        const bridge = new Bridge(), handle = createXrefReader(bridge, SESSION);
        if (stage === 'read') await handle.reader.identify!(LEAF, context());
        const gate = bridge.hold(stage);
        const pending = observe(stage === 'read' ? handle.reader.readText(LEAF, context()) : handle.reader.identify!(LEAF, context()));
        let retirement: Promise<void> | undefined;
        try {
          await gate.entered.promise;
          if (retire === 'setSession') handle.setSession(NEXT_SESSION); else retirement = handle.dispose();
          gate.completion.reject(new Error('ERR_XREF_DENIED: delayed original-session refusal'));
          const error = failure(await pending);
          expect(error.name).toBe('AbortError');
          expect(bridge.calls.filter(call => call.method === 'begin')).toHaveLength(1);
          expect(bridge.calls.filter(call => call.method === 'read')).toHaveLength(stage === 'read' ? 1 : 0);
          expect(bridge.calls.filter(call => call.method === 'begin').map(call => call.info)).toEqual([
            { docId: SESSION.docId, contentGeneration: SESSION.contentGeneration, hostAnchor: SESSION.hostPath },
          ]);
        } finally {
          gate.completion.resolve();
          await pending;
          await retirement;
          await handle.dispose();
        }
      });
    }
  }
});

describe('lead review: read-first continuation must recheck after nested identify', () => {
  for (const retire of ['setSession', 'dispose'] as const satisfies readonly Retire[]) {
    it(`nested identify fulfilled before ${retire}: no cleared-ticket dereference or new-session I/O`, async () => {
      const bridge = new Bridge(), handle = createXrefReader(bridge, SESSION);
      const entered = deferred<void>(), resume = deferred<void>();
      const originalIdentify = handle.reader.identify!.bind(handle.reader);
      // Pause only the publicly awaited identify result after the actual adapter has
      // accepted/stored it. This isolates the second await boundary in readText.
      handle.reader.identify = async (path, ctx) => {
        const identity = await originalIdentify(path, ctx);
        entered.resolve();
        await resume.promise;
        return identity;
      };
      const pending = observe(handle.reader.readText(LEAF, context()));
      let retirement: Promise<void> | undefined;
      try {
        await entered.promise;
        if (retire === 'setSession') handle.setSession(NEXT_SESSION); else retirement = handle.dispose();
        resume.resolve();
        const error = failure(await pending);
        expect(error.name).toBe('AbortError');
        expect(error).not.toBeInstanceOf(TypeError);
        expect(bridge.calls.filter(call => call.method === 'read')).toEqual([]);
        expect(bridge.calls.filter(call => call.method === 'begin')).toHaveLength(1);
        expect(bridge.calls.filter(call => call.method === 'identify')).toHaveLength(1);
      } finally {
        resume.resolve();
        await pending;
        await retirement;
        handle.reader.identify = originalIdentify;
        await handle.dispose();
      }
    });
  }
});

const refusals = [
  { broker: 'ERR_XREF_DENIED', code: 'EACCES', name: 'Error' },
  { broker: 'ERR_XREF_MISSING', code: 'ENOENT', name: 'Error' },
  { broker: 'ERR_XREF_CANCELLED', code: undefined, name: 'AbortError' },
] as const;

describe('lead review: established Electron invoke envelope preserves broker classification', () => {
  for (const stage of ['identify', 'read'] as const) {
    for (const refusal of refusals) {
      for (const wrapped of [false, true]) {
        it(`${stage} ${wrapped ? 'Electron-wrapped' : 'bare control'} ${refusal.broker}`, async () => {
          const bridge = new Bridge(), handle = createXrefReader(bridge, SESSION);
          try {
            if (stage === 'read') await handle.reader.identify!(LEAF, context());
            const bare = `${refusal.broker}: authored boundary refusal`;
            const channel = stage === 'read' ? 'xref-read' : 'xref-identify';
            bridge.rejection = { stage, error: new Error(wrapped ? `Error invoking remote method '${channel}': Error: ${bare}` : bare) };
            const result = await observe(stage === 'read' ? handle.reader.readText(LEAF, context()) : handle.reader.identify!(LEAF, context()));
            const error = failure(result);
            expect(error.name).toBe(refusal.name);
            expect(error.code).toBe(refusal.code);
          } finally {
            await handle.dispose();
          }
        });
      }
    }
  }
});
