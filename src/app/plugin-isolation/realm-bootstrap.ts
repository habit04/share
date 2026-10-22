/**
 * P25 plugin capability isolation — the realm bootstrap.
 *
 * `realmBootstrapMain` is the ONLY code that runs in the plugin realm besides
 * the plugin itself. It is written to be self-contained (no imports, no
 * closure over module scope): its source text is serialised verbatim as
 * REALM_BOOTSTRAP_SOURCE for the Node worker_threads path, and the browser
 * worker entry (realm-worker.ts) calls the same function directly, so the
 * tested realm code is the shipped realm code.
 *
 * Security invariants held here:
 * - the transport and both nonces live only in this function's closure —
 *   never on a global, never in the `jcad` proxy handed to plugin code;
 * - before plugin code runs, the raw channel and network/process globals are
 *   replaced with throwing stubs on the realm global object (threat T8), so a
 *   plugin cannot speak on the channel except through the validating proxy,
 *   and cannot forge messages: it has no nonce (threat T5);
 * - `eval` and the `Function` constructor are likewise locked to throwing
 *   stubs at handshake time (the lead's CSP ruling, 2026-10-21: eval and
 *   new Function are refused in the plugin context);
 * - the plugin entry is loaded as an ES module — a dynamic import() of the
 *   host-supplied module URL (AMENDMENT-P25-CSP-HOSTING Part B) — and the
 *   bootstrap contains NO string evaluation at all: the Function-constructor
 *   body compilation of the CSP-ruling delivery is gone, so there is no
 *   call site any transport could select to compile a plugin body string.
 *   The entry module receives the session's `jcad` proxy through the
 *   one-line jcad.js shim (Part B2, in the handshake handler below).
 *
 * The importer itself arrives as this function's argument, never as a
 * literal `import()` in this body: this function is serialised verbatim
 * into the Node worker_threads realm (REALM_BOOTSTRAP_SOURCE below),
 * where a literal dynamic-import expression would be rewritten by the
 * test pipeline's module transform into a helper that does not exist in
 * the bare realm. The browser worker entry (realm-worker.ts, a real
 * module) passes the platform's native dynamic import; the serialised
 * source string appends the same expression as inert text the transform
 * leaves alone, so the tested realm code and the shipped realm code run
 * the identical function.
 */

export function realmBootstrapMain(importModule?: (url: string) => Promise<unknown>): void {
  const g = globalThis as unknown as Record<string, unknown>;

  // ---- transport detection (browser/Electron worker, or Node worker_threads)
  let send: (msg: unknown) => void = () => {
    throw new Error('isolated realm transport is not connected');
  };
  let onMessage: (cb: (msg: unknown) => void) => void = () => undefined;
  let nodePort: { postMessage: (m: unknown) => void; on: (ev: string, cb: (m: unknown) => void) => void } | null = null;
  try {
    // In a Node worker the main script runs in a CommonJS scope where
    // `require` exists; in a browser worker it does not (typeof is safe).
    if (typeof require === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate scope probe: this function is serialised into a worker realm, where a static import cannot be used to detect the Node transport
      const wt = require('node:worker_threads') as { parentPort: { postMessage: (m: unknown) => void; on: (ev: string, cb: (m: unknown) => void) => void } | null };
      if (wt && wt.parentPort) nodePort = wt.parentPort;
    }
  } catch {
    nodePort = null;
  }
  if (nodePort) {
    const port = nodePort;
    send = (m) => port.postMessage(m);
    onMessage = (cb) => port.on('message', cb);
  } else if (typeof g.postMessage === 'function' && typeof g.addEventListener === 'function') {
    const post = g.postMessage as (m: unknown) => void;
    const add = g.addEventListener as (type: string, cb: (ev: { data: unknown }) => void) => void;
    send = (m) => post.call(g, m);
    onMessage = (cb) => add.call(g, 'message', (ev: { data: unknown }) => cb(ev.data));
  }

  // ---- session state (closure-only; plugin code can never reach this)
  let session = '';
  let realmNonce = '';
  let hostNonce = '';
  let handshaken = false;
  let seq = 0;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const callbacks = new Map<string, { fn: (...args: never[]) => unknown; kind: 'command' | 'event' | 'unload' }>();
  let callbackSeq = 0;
  const unloadIds: string[] = [];
  /** The realm's jcad proxy (built at handshake); command callbacks receive it as their first argument, like v1. */
  let jcadRef: Record<string, unknown> | null = null;

  const rpcError = (failure: { code?: string; message?: string } | undefined): Error => {
    const err = new Error(failure?.message ?? 'plugin RPC failed') as Error & { code?: string };
    err.code = failure?.code ?? 'internal';
    return err;
  };

  function rpc(method: string, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = `r${++seq}`;
      pending.set(id, { resolve, reject });
      try {
        send({ kind: 'rpc', v: 2, session, nonce: realmNonce, id, method, args });
      } catch (err) {
        pending.delete(id);
        reject(err as Error);
      }
    });
  }

  function registerCallback(fn: (...args: never[]) => unknown, kind: 'command' | 'event' | 'unload'): string {
    const id = `cb${++callbackSeq}`;
    callbacks.set(id, { fn, kind });
    if (kind === 'unload') unloadIds.push(id);
    return id;
  }

  // ---- the async v2 proxy handed to plugin code
  function buildJcad(name: string, version: string): Record<string, unknown> {
    // Transaction staging: while a transact callback runs, mutating calls are
    // collected locally and sent as ONE document.transactBatch at the end, so
    // the host applies them in a single v1 transact (one undo step, atomic).
    // Staged results are provisional: they resolve immediately (ids are
    // pre-assigned by the proxy) and the transact promise itself rejects if
    // the host rolls the batch back — plugins must treat transact() as the
    // commit point. Reads during a transaction go to the host and see
    // committed state. Any OTHER mutating call is refused while a transact
    // callback runs (see direct() below): it would take effect immediately
    // and survive a rollback, breaking the §3/T9 atomicity promise (F-2).
    let staged: Array<{ method: string; args: unknown[] }> | null = null;
    let idSeq = 0;
    const provisionalId = (): string => `iso-${Date.now().toString(36)}-${++idSeq}`;

    const withIds = (input: unknown): { value: unknown; ids: string[] } => {
      const list = Array.isArray(input) ? input : [input];
      const ids: string[] = [];
      const value = list.map((item) => {
        if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id !== 'string') {
          const copy = Object.assign({}, item as Record<string, unknown>, { id: provisionalId() });
          ids.push(copy.id as string);
          return copy;
        }
        ids.push(String((item as { id?: unknown }).id));
        return item;
      });
      return { value: Array.isArray(input) ? value : value[0], ids };
    };

    const mutating = (method: string, args: unknown[]): Promise<unknown> => {
      if (staged) {
        if (method === 'document.add') {
          const prepared = withIds(args[0]);
          staged.push({ method, args: [prepared.value] });
          return Promise.resolve(prepared.ids);
        }
        staged.push({ method, args });
        if (method === 'document.replace') {
          const list = Array.isArray(args[0]) ? (args[0] as Array<{ id?: unknown }>) : [args[0] as { id?: unknown }];
          return Promise.resolve(list.map((e) => String(e?.id)));
        }
        if (method === 'document.remove') {
          const list = Array.isArray(args[0]) ? (args[0] as unknown[]) : [args[0]];
          return Promise.resolve(new Set(list.map(String)).size);
        }
        return Promise.resolve(undefined);
      }
      return rpc(method, args);
    };

    // F-2 (slice-1 acceptance): only the mutating() methods above can be
    // staged. Every other call goes through direct(): read-only methods may
    // run while a transaction is being staged (they see committed state),
    // but a non-stageable MUTATING call is refused while a transact
    // callback is active — executed immediately, it would survive the
    // batch's rollback and silently break atomicity (§3 / T9). Fail-closed,
    // like the rest of the realm: the plugin calls it outside transact().
    const READ_ONLY = new Set([
      'document.info', 'document.entities', 'document.entity', 'document.selection',
      'document.layers', 'document.currentLayer', 'document.blocks', 'document.extents',
      'document.header', 'settings.get', 'settings.keys', 'commands.list',
      'geometry.bounds', 'electrical.components', 'electrical.wires',
    ]);
    const direct = (method: string, args: unknown[]): Promise<unknown> => {
      if (staged && !READ_ONLY.has(method)) {
        return Promise.reject(new Error(
          `"${method}" cannot run inside document.transact in the isolated realm: it takes effect immediately and cannot be rolled back. Call it before or after the transaction instead.`,
        ));
      }
      return rpc(method, args);
    };

    const doc = {
      info: () => direct('document.info', []),
      entities: (filter?: unknown) => direct('document.entities', [filter ?? null]),
      entity: (id: string) => direct('document.entity', [id]),
      selection: () => direct('document.selection', []),
      select: (ids: string[]) => direct('document.select', [ids]),
      add: (input: unknown) => mutating('document.add', [input]),
      replace: (input: unknown) => mutating('document.replace', [input]),
      remove: (ids: unknown) => mutating('document.remove', [ids]),
      layers: () => direct('document.layers', []),
      currentLayer: () => direct('document.currentLayer', []),
      blocks: () => direct('document.blocks', []),
      extents: () => direct('document.extents', []),
      header: () => direct('document.header', []),
      undo: () => direct('document.undo', []),
      redo: () => direct('document.redo', []),
      transact: (fn: () => unknown) => {
        if (staged) return Promise.reject(new Error('transact cannot be nested in the isolated API; finish the outer transaction first.'));
        if (typeof fn !== 'function') return Promise.reject(new TypeError('transact needs a function.'));
        const ops: Array<{ method: string; args: unknown[] }> = [];
        staged = ops;
        let result: unknown;
        try {
          result = fn();
        } catch (err) {
          staged = null;
          return Promise.reject(err as Error);
        }
        const finish = (value: unknown) => {
          staged = null;
          return rpc('document.transactBatch', [ops]).then(() => value);
        };
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          return (result as Promise<unknown>).then(finish, (err: unknown) => {
            staged = null;
            throw err;
          });
        }
        return finish(result);
      },
    };

    const eventsByFn = new Map<unknown, string>();
    const jcad: Record<string, unknown> = {
      apiVersion: 2,
      version,
      plugin: {
        name,
        onUnload: (fn: () => void) => {
          registerCallback(fn as (...args: never[]) => unknown, 'unload');
        },
      },
      commands: {
        register: (spec: { name: string; aliases?: string[]; description?: string; override?: boolean; run: unknown }) => {
          if (!spec || typeof spec.run !== 'function') throw new TypeError('commands.register needs { name, run(jcad, arg) }.');
          const callback = registerCallback(spec.run as (...args: never[]) => unknown, 'command');
          const meta = { name: spec.name, aliases: spec.aliases ?? [], description: spec.description ?? '', override: spec.override === true };
          return direct('commands.register', [meta, callback]).then(() => () => direct('commands.unregister', [String(spec.name)]));
        },
        run: (cmdName: string, arg?: string) => direct('commands.run', [cmdName, arg ?? null]),
        list: () => direct('commands.list', []),
      },
      document: doc,
      electrical: {
        components: () => direct('electrical.components', []),
        wires: () => direct('electrical.wires', []),
        setAttributes: (id: string, values: Record<string, unknown>) => mutating('electrical.setAttributes', [id, values]),
        crossReference: () => direct('electrical.crossReference', []),
      },
      ui: {
        log: (msg: unknown) => direct('ui.log', [typeof msg === 'string' ? msg : JSON.stringify(msg) ?? String(msg)]),
        prompt: (text: string, dflt?: string) => direct('ui.prompt', [text, dflt ?? null]),
        pick: {
          point: (prompt?: string) => direct('ui.pickPoint', [prompt ?? null]),
          entities: (prompt?: string) => direct('ui.pickEntities', [prompt ?? null]),
        },
        alert: (msg: string, title?: string) => direct('ui.alert', [String(msg), title ?? null]),
        confirm: (msg: string, title?: string) => direct('ui.confirm', [String(msg), title ?? null]),
        openDialog: (options: unknown) => direct('ui.openDialog', [options]),
      },
      events: {
        on: (ev: string, fn: (payload?: unknown) => void) => {
          // events.on is synchronous, so the F-2 refusal throws here instead
          // of rejecting (a rejected fire-and-forget RPC would be swallowed).
          if (staged) {
            throw new Error('"events.on" cannot run inside document.transact in the isolated realm: a subscription takes effect immediately and cannot be rolled back. Subscribe before or after the transaction instead.');
          }
          const callback = registerCallback(fn as (...args: never[]) => unknown, 'event');
          eventsByFn.set(fn, callback);
          void rpc('events.on', [ev, callback]).catch(() => undefined);
          return () => direct('events.off', [ev, callback]);
        },
        off: (ev: string, fn: (payload?: unknown) => void) => {
          const callback = eventsByFn.get(fn);
          if (callback) return direct('events.off', [ev, callback]);
          return Promise.resolve(false);
        },
      },
      settings: {
        get: (key: string) => direct('settings.get', [key]),
        set: (key: string, value: unknown) => direct('settings.set', [key, value]),
        keys: () => direct('settings.keys', []),
      },
      files: {
        requestRead: (accept?: string) => direct('files.requestRead', [accept ?? null]),
        readGrant: (grant: string) => direct('files.readGrant', [grant]),
        readText: (accept?: string) =>
          direct('files.requestRead', [accept ?? null]).then((g) => direct('files.readGrant', [(g as { grant: string }).grant])),
        saveText: (fileName: string, text: string, filterName?: string) => direct('files.saveText', [fileName, text, filterName ?? null]),
      },
      geometry: {
        // Pure math runs locally in the realm; bounds reads the drawing, so it is an RPC.
        distance: (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(b.x - a.x, b.y - a.y),
        angle: (from: { x: number; y: number }, to: { x: number; y: number }) => Math.atan2(to.y - from.y, to.x - from.x),
        polar: (from: { x: number; y: number }, angle: number, distance: number) => ({ x: from.x + Math.cos(angle) * distance, y: from.y + Math.sin(angle) * distance }),
        midpoint: (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }),
        bounds: (items: unknown[]) => direct('geometry.bounds', [items]),
        rad: (deg: number) => (deg * Math.PI) / 180,
        deg: (rad: number) => (rad * 180) / Math.PI,
      },
    };
    return jcad;
  }

  // ---- global hardening, installed at handshake time (threat T8)
  function hardenGlobals(): void {
    const deny = (what: string) => () => {
      throw new Error(`${what} is not available in the isolated plugin realm`);
    };
    const lock = (key: string, value: unknown) => {
      try {
        Object.defineProperty(g, key, { value, writable: false, configurable: false, enumerable: false });
      } catch {
        try {
          g[key] = value;
        } catch {
          /* a non-writable existing global cannot be shadowed; the nonce check (T5) still holds */
        }
      }
    };
    lock('postMessage', deny('postMessage'));
    lock('fetch', deny('fetch'));
    lock('XMLHttpRequest', deny('XMLHttpRequest'));
    lock('WebSocket', deny('WebSocket'));
    lock('importScripts', deny('importScripts'));
    lock('process', undefined);
    lock('require', undefined);
    lock('Buffer', undefined);
    lock('jcad', undefined);
    // F-1 (slice-1 acceptance, CRITICAL): the CommonJS identifiers are own
    // properties of globalThis under the Node worker_threads realm, and the
    // unlocked `module` was the bootstrap's real Module instance —
    // module.require('node:fs') read host files from a zero-capability
    // plugin. Lock all four alongside the others. (Browser realms have no
    // CJS globals; defining them as undefined there is a no-op.)
    lock('module', undefined);
    lock('exports', undefined);
    lock('__filename', undefined);
    lock('__dirname', undefined);
    // CSP ruling (2026-10-21): eval and the Function constructor are refused
    // in the plugin context. The stub is a plain function (not an arrow) so
    // that a Function construction throws this same named refusal instead
    // of an incidental "not a constructor" TypeError. No bootstrap code uses the
    // constructor at all — the realm loads its plugin entry as a module
    // (Part B), it compiles no body string. Residue, stated plainly: a
    // function object's own `.constructor` chain still reaches the
    // intrinsic in a realm with no CSP — the packaged worker CSP
    // (script-src 'self' 'wasm-unsafe-eval') is the platform-level refusal
    // there, and in every realm the host's capability enforcement bounds
    // what realm-local code can do: no channel, no nonce, no host globals.
    const denyCall = (what: string) =>
      function (): never {
        throw new Error(`${what} is not available in the isolated plugin realm`);
      };
    lock('eval', denyCall('eval'));
    lock('Function', denyCall('Function'));
    // Fable F3: nested workers. A plugin that could construct its own
    // Worker/SharedWorker would gain an unmediated realm — same origin
    // class, none of this session's stubs, nonces or capability checks.
    // Worker creation belongs to the host (the realm itself is host-made),
    // so both constructors are locked to the same throwing stub shape as
    // Function (a plain function, so `new Worker()` throws this named
    // refusal rather than an incidental "not a constructor" error). The
    // stub applies to the plugin realm's globals only; the host's own
    // transport machinery is untouched and the realm still loads.
    lock('Worker', denyCall('Worker'));
    lock('SharedWorker', denyCall('SharedWorker'));
  }

  // ---- message pump
  onMessage((raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const msg = raw as Record<string, unknown>;
    if (!handshaken) {
      if (msg.kind !== 'handshake' || msg.v !== 2) return;
      session = String(msg.session ?? '');
      realmNonce = String(msg.realmNonce ?? '');
      hostNonce = String(msg.hostNonce ?? '');
      handshaken = true;
      hardenGlobals();
      const jcad = buildJcad(String(msg.name ?? 'plugin'), String(msg.version ?? ''));
      jcadRef = jcad;
      const moduleUrl = typeof msg.moduleUrl === 'string' ? msg.moduleUrl : '';
      const failLoad = (err: unknown) => {
        send({ kind: 'load-done', v: 2, session, nonce: realmNonce, ok: false, error: err instanceof Error ? err.message : String(err) });
      };
      if (!moduleUrl) {
        failLoad(new Error('the isolated handshake carries no module URL; the realm loads its plugin entry as a module and compiles no body string'));
        return;
      }
      if (typeof importModule !== 'function') {
        failLoad(new Error('the isolated realm has no module loader; the realm loads its plugin entry as a module and compiles no body string'));
        return;
      }
      // Part B2: hand the session's jcad proxy to the entry module through
      // the well-known global slot the jcad.js shim reads
      // (`export default globalThis[Symbol.for("jcad.isolated.jcad")]`),
      // import the entry, and delete the slot as soon as the import
      // settles. The slot carries only THIS session's proxy — which
      // enforces the declared capabilities on every call — and no nonce;
      // the load report is the module namespace's default export,
      // JSON-cloned exactly as a body report was under the string form.
      // A module that throws, or imports something unresolvable, fails
      // the load closed.
      const slots = g as Record<PropertyKey, unknown>;
      const JCAD_SLOT = Symbol.for('jcad.isolated.jcad');
      slots[JCAD_SLOT] = jcad;
      void importModule(moduleUrl)
        .then((namespace) => {
          const value = (namespace as { default?: unknown } | null)?.default;
          let report: unknown;
          try {
            report = value === undefined ? null : JSON.parse(JSON.stringify(value)) as unknown;
          } catch {
            report = { unreportable: true };
          }
          send({ kind: 'load-done', v: 2, session, nonce: realmNonce, ok: true, report });
        }, failLoad)
        .finally(() => {
          try {
            delete slots[JCAD_SLOT];
          } catch {
            slots[JCAD_SLOT] = undefined;
          }
        });
      return;
    }
    if (msg.session !== session) return;
    if (msg.kind === 'rpc-res') {
      if (msg.nonce !== hostNonce) return;
      const entry = pending.get(String(msg.id));
      if (!entry) return;
      pending.delete(String(msg.id));
      if (msg.ok === true) entry.resolve(msg.value);
      else entry.reject(rpcError(msg.error as { code?: string; message?: string } | undefined));
      return;
    }
    if (msg.kind === 'call') {
      if (msg.nonce !== hostNonce) return;
      const id = String(msg.id);
      const reply = (ok: boolean, value?: unknown, error?: { code: string; message: string }) => {
        send({ kind: 'call-res', v: 2, session, nonce: realmNonce, id, ok, ...(ok ? { value: value ?? null } : { error }) });
      };
      if (msg.callback === '__unload__') {
        void (async () => {
          for (const cbId of unloadIds) {
            const hook = callbacks.get(cbId);
            if (hook) {
              try {
                await hook.fn();
              } catch {
                /* unload hooks are best-effort; disposal continues */
              }
            }
          }
          reply(true, null);
        })();
        return;
      }
      const target = callbacks.get(String(msg.callback));
      if (!target) {
        reply(false, undefined, { code: 'bad-request', message: `unknown callback "${String(msg.callback)}"` });
        return;
      }
      const args = Array.isArray(msg.args) ? msg.args : [];
      try {
        const out =
          target.kind === 'command'
            ? target.fn(jcadRef as never, ...(args as never[]))
            : target.fn(...(args as never[]));
        if (out && typeof (out as Promise<unknown>).then === 'function') {
          (out as Promise<unknown>).then(
            (v) => reply(true, v),
            (err: unknown) => reply(false, undefined, { code: 'internal', message: err instanceof Error ? err.message : String(err) }),
          );
        } else {
          reply(true, out);
        }
      } catch (err) {
        reply(false, undefined, { code: 'internal', message: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (msg.kind === 'unload') {
      if (msg.nonce !== hostNonce) return;
      const id = String(msg.id);
      const run = async () => {
        for (const cbId of unloadIds) {
          const target = callbacks.get(cbId);
          if (target) {
            try {
              await target.fn();
            } catch {
              /* unload hooks are best-effort; disposal continues */
            }
          }
        }
        send({ kind: 'call-res', v: 2, session, nonce: realmNonce, id, ok: true, value: null });
      };
      void run();
    }
  });
}

/**
 * The bootstrap as source text (Node worker_threads `eval` path). The
 * module importer is appended as an argument expression — inert string
 * content here, real code only when the worker evaluates it — for the
 * reason realmBootstrapMain's header gives: no literal dynamic-import
 * expression may appear in the serialised function body itself.
 */
export const REALM_BOOTSTRAP_SOURCE = `(${realmBootstrapMain.toString()})((url) => import(url));`;
