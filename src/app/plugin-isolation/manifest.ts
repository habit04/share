/**
 * P25 plugin capability isolation — isolated-manifest parsing.
 *
 * This is the isolated modules' reference implementation of the PluginManifest
 * extension filed as PROPOSAL-P25 in the six-pipeline ledger. The proposal was
 * ADMITTED (LEDGER L-011): `PluginManifest` in ../plugins.ts now carries the
 * fields, and parseManifest / PluginHost.load enforce these exact semantics
 * (same messages, same order of checks). This parser remains so the isolated
 * realm has a fail-closed declaration format independent of the host.
 *
 * Rules (fail-closed — every violation is an IsolatedManifestError):
 * - no `isolation` field (or `"page"`): a legacy API v1 manifest, capabilities [];
 * - `isolation: "worker"` requires `apiVersion: 2` and a `capabilities` array
 *   whose entries all belong to the known capability vocabulary;
 * - `capabilities` without `isolation: "worker"` is an error (a declaration the
 *   trusted page path would silently ignore must never look enforced).
 */
import { parseCapabilitySet, type PluginCapability } from './capabilities';

export class IsolatedManifestError extends Error {
  override readonly name = 'IsolatedManifestError';
}

export interface IsolatedManifest {
  name: string;
  version?: string;
  description?: string;
  author?: string;
  /** Entry file next to plugin.json (default main.js), same rule as v1. */
  main: string;
  apiVersion: number;
  isolation: 'page' | 'worker';
  capabilities: ReadonlySet<PluginCapability>;
}

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function parseIsolatedManifest(text: string, fallbackName?: string): IsolatedManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new IsolatedManifestError(`plugin.json is not valid JSON (${(err as Error).message})`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new IsolatedManifestError('plugin.json must be an object');
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === 'string' && o.name ? o.name : fallbackName;
  if (!name || !NAME_RE.test(name)) throw new IsolatedManifestError(`plugin name "${String(name)}" must be 1-64 letters, digits, dot, dash or underscore`);
  const main = o.main === undefined ? 'main.js' : String(o.main);
  if (!/^[A-Za-z0-9._-]+\.js$/.test(main)) throw new IsolatedManifestError(`"main" must be a .js file name in the plugin folder, not "${main}"`);
  const apiVersion = o.apiVersion === undefined ? 1 : Number(o.apiVersion);
  if (!Number.isInteger(apiVersion) || apiVersion < 1) throw new IsolatedManifestError('"apiVersion" must be a positive integer');

  const isolationRaw = o.isolation;
  if (isolationRaw !== undefined && isolationRaw !== 'page' && isolationRaw !== 'worker') {
    throw new IsolatedManifestError(`"isolation" must be "page" or "worker", not ${JSON.stringify(isolationRaw)}`);
  }
  const isolation = isolationRaw === 'worker' ? 'worker' : 'page';

  let capabilities: ReadonlySet<PluginCapability>;
  try {
    capabilities = parseCapabilitySet(o.capabilities);
  } catch (err) {
    throw new IsolatedManifestError((err as Error).message);
  }
  if (isolation === 'worker') {
    if (apiVersion !== 2) throw new IsolatedManifestError('an isolated ("worker") plugin must declare "apiVersion": 2 (API v2 is the asynchronous realm API)');
    if (o.capabilities === undefined) throw new IsolatedManifestError('an isolated ("worker") plugin must declare "capabilities" (use [] for a plugin that only loads)');
  } else if (o.capabilities !== undefined) {
    throw new IsolatedManifestError('"capabilities" requires "isolation": "worker" (the trusted page path enforces no capabilities; declaring them there would be misleading)');
  }

  return {
    name,
    main,
    apiVersion,
    isolation,
    capabilities,
    ...(typeof o.version === 'string' ? { version: o.version } : {}),
    ...(typeof o.description === 'string' ? { description: o.description } : {}),
    ...(typeof o.author === 'string' ? { author: o.author } : {}),
  };
}
