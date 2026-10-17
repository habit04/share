/**
 * Priority 20.2 — thin xref adapter (src/app/xref-reader.ts) over a fake
 * broker bridge, plus one end-to-end pass through the real loading core.
 * The adapter must create only reader/context capabilities: no store,
 * no load, no document state.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createXrefReader, type XrefBrokerBridge, type XrefReaderSession } from '../src/app/xref-reader';
import { stageXrefLoad, type XrefFileIdentity } from '../src/io/xref-loading';

const HOST = 'C:\\proj\\host.dxf';
const LEAF = 'C:\\proj\\leaf.dxf';
const SESSION: XrefReaderSession = { docId: 'doc-1', contentGeneration: 3, hostPath: HOST };
const LEAF_IDENTITY: XrefFileIdentity = { id: 'win:7:42', owningLocation: LEAF, version: '["7","42","100","1000","2000"]' };
const LEAF_TEXT = readFileSync(new URL('./fixtures/xref/leaf.dxf', import.meta.url), 'utf8');

class FakeBridge implements XrefBrokerBridge {
  calls: Array<{ method: string; args: unknown[] }> = [];
  tokens = 0;
  gateRead: (() => void) | null = null;
  private releaseRead: (() => void) | null = null;

  async beginXrefContext(info: { docId: string; contentGeneration: number | string; hostAnchor: string }) {
    this.calls.push({ method: 'begin', args: [info] });
    return { token: `token-${++this.tokens}` };
  }
  async identifyXref(token: string, path: string) {
    this.calls.push({ method: 'identify', args: [token, path] });
    if (path === LEAF) return { ticket: 'ticket-leaf', identity: LEAF_IDENTITY };
    if (path === HOST) return { ticket: 'ticket-host', identity: { id: 'win:7:10', owningLocation: HOST, version: '["7","10","50","1000","2000"]' } };
    if (path === 'C:\\secret\\leaf.dxf') throw new Error('ERR_XREF_DENIED: not readable by name');
    throw new Error('ERR_XREF_MISSING: no readable file');
  }
  async readXref(token: string, ticket: string, maxBytes: number) {
    this.calls.push({ method: 'read', args: [token, ticket, maxBytes] });
    if (this.gateRead) {
      const gate = new Promise<void>((resolve) => { this.releaseRead = resolve; });
      this.gateRead();
      await gate;
    }
    return { text: LEAF_TEXT, byteLength: Buffer.byteLength(LEAF_TEXT, 'utf8'), version: LEAF_IDENTITY.version };
  }
  release() { this.releaseRead?.(); }
  async cancelXref(token: string) { this.calls.push({ method: 'cancel', args: [token] }); return true; }
  async closeXrefContext(token: string) { this.calls.push({ method: 'close', args: [token] }); return true; }
  methods(): string[] { return this.calls.map((c) => c.method); }
}

const ctx = (signal?: AbortSignal) => ({ resolvedPath: LEAF, originalPath: 'leaf.dxf', blockName: 'L', depth: 1, ...(signal ? { signal } : {}) });
const readCtx = (signal?: AbortSignal) => ({ ...ctx(signal), maxBytes: 4096 });

describe('xref adapter — context and ticket translation', () => {
  it('begins lazily with the captured labels and reads through the identify ticket', async () => {
    const bridge = new FakeBridge();
    const handle = createXrefReader(bridge, SESSION);
    expect(bridge.calls).toEqual([]); // nothing happens until first use
    const identity = await handle.reader.identify!(LEAF, ctx());
    expect(identity).toEqual(LEAF_IDENTITY);
    expect(bridge.calls[0]).toEqual({ method: 'begin', args: [{ docId: 'doc-1', contentGeneration: 3, hostAnchor: HOST }] });
    const result = await handle.reader.readText(LEAF, readCtx());
    expect(result).toEqual({ text: LEAF_TEXT, byteLength: Buffer.byteLength(LEAF_TEXT, 'utf8'), version: LEAF_IDENTITY.version });
    expect(bridge.methods()).toEqual(['begin', 'identify', 'read']);
    expect(bridge.calls[2]!.args).toEqual(['token-1', 'ticket-leaf', 4096]); // the core's allowance is forwarded
  });

  it('a read with no prior identify identifies through the same context first', async () => {
    const bridge = new FakeBridge();
    const handle = createXrefReader(bridge, SESSION);
    await handle.reader.readText(LEAF, readCtx());
    expect(bridge.methods()).toEqual(['begin', 'identify', 'read']);
  });

  it('maps broker refusals to the codes the core classifies by (denied is EACCES, never missing)', async () => {
    const bridge = new FakeBridge();
    const handle = createXrefReader(bridge, SESSION);
    const denied = await handle.reader.identify!('C:\\secret\\leaf.dxf', ctx()).catch((e: unknown) => e) as { code?: string };
    expect(denied.code).toBe('EACCES');
    const missing = await handle.reader.identify!('C:\\proj\\ghost.dxf', ctx()).catch((e: unknown) => e) as { code?: string };
    expect(missing.code).toBe('ENOENT');
  });
});

describe('xref adapter — cancellation and session lifecycle', () => {
  it('abort during a read cancels the broker context and refuses the late completion', async () => {
    const bridge = new FakeBridge();
    const handle = createXrefReader(bridge, SESSION);
    await handle.reader.identify!(LEAF, ctx());
    const controller = new AbortController();
    bridge.gateRead = () => {};
    const pending = handle.reader.readText(LEAF, readCtx(controller.signal));
    await new Promise((r) => setImmediate(r));
    controller.abort();
    expect(bridge.methods()).toContain('cancel');
    expect(bridge.calls.find((c) => c.method === 'cancel')!.args).toEqual(['token-1']);
    bridge.release(); // the native read now completes with valid content…
    const error = await pending.catch((e: unknown) => e) as Error;
    expect(error.name).toBe('AbortError'); // …and is still refused adapter-side
  });

  it('an already-aborted signal refuses before any read IPC', async () => {
    const bridge = new FakeBridge();
    const handle = createXrefReader(bridge, SESSION);
    const controller = new AbortController();
    controller.abort();
    const error = await handle.reader.readText(LEAF, readCtx(controller.signal)).catch((e: unknown) => e) as Error;
    expect(error.name).toBe('AbortError');
    expect(bridge.methods()).not.toContain('read');
  });

  it('same-session setSession is a no-op; a new generation or a Save As anchor retires the old context', async () => {
    const bridge = new FakeBridge();
    const handle = createXrefReader(bridge, SESSION);
    await handle.reader.identify!(LEAF, ctx());
    handle.setSession(SESSION);
    await handle.reader.identify!(LEAF, ctx());
    expect(bridge.methods().filter((m) => m === 'begin')).toHaveLength(1);
    expect(bridge.methods()).not.toContain('close');

    handle.setSession({ ...SESSION, contentGeneration: 4 });
    await new Promise((r) => setImmediate(r));
    expect(bridge.calls.find((c) => c.method === 'close')!.args).toEqual(['token-1']);
    await handle.reader.identify!(LEAF, ctx());
    expect(bridge.calls.filter((c) => c.method === 'begin')[1]!.args).toEqual([{ docId: 'doc-1', contentGeneration: 4, hostAnchor: HOST }]);

    handle.setSession({ docId: 'doc-1', contentGeneration: 4, hostPath: 'C:\\proj\\saved-as.dxf' });
    await new Promise((r) => setImmediate(r));
    expect(bridge.calls.filter((c) => c.method === 'close')).toHaveLength(2);
    expect(handle.session.hostPath).toBe('C:\\proj\\saved-as.dxf');
  });

  it('dispose retires the context and refuses later operations, idempotently', async () => {
    const bridge = new FakeBridge();
    const handle = createXrefReader(bridge, SESSION);
    await handle.reader.identify!(LEAF, ctx());
    await handle.dispose();
    await handle.dispose();
    expect(bridge.calls.filter((c) => c.method === 'close')).toHaveLength(1);
    const error = await handle.reader.identify!(LEAF, ctx()).catch((e: unknown) => e) as { code?: string };
    expect(error.code).toBe('ERR_XREF_CONTEXT');
  });

  it('exposes only reader/context capabilities — no store, no load, no document surface', () => {
    const handle = createXrefReader(new FakeBridge(), SESSION);
    expect(Object.keys(handle).sort()).toEqual(['dispose', 'reader', 'session', 'setSession']);
    expect(Object.keys(handle.reader).sort()).toEqual(['identify', 'readText']);
    const raw = readFileSync(new URL('../src/app/xref-reader.ts', import.meta.url), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/new XrefStore|stageXrefLoad\(|from '\.\.\/(ui|app\/editor)/);
    expect(raw).toMatch(/import type \{[^}]*\} from '\.\.\/io\/xref-loading'/);
  });
});

describe('xref adapter — end-to-end through the loading core', () => {
  it('a granted reference loads and an ungranted one is classified denied by the core', async () => {
    const bridge = new FakeBridge();
    const handle = createXrefReader(bridge, SESSION);
    const outcome = await stageXrefLoad(
      {
        references: [
          { blockName: 'L', path: LEAF },
          { blockName: 'S', path: 'C:\\secret\\leaf.dxf' },
        ],
        hostPath: HOST,
      },
      { reader: handle.reader },
    );
    expect(outcome.snapshot!.nodes.map((n) => n.status)).toEqual(['loaded', 'denied']);
    expect(outcome.snapshot!.files['id:win:7:42']!.owningLocation).toBe(LEAF);
    // The host itself was identified through the same broker (depth 0 begin + identify).
    expect(bridge.calls.filter((c) => c.method === 'identify').map((c) => c.args[1])).toContain(HOST);
  });
});
