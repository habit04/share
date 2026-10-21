/**
 * P25 plugin capability isolation — the declared-capability vocabulary.
 *
 * A capability is a string a plugin declares in its manifest (see manifest.ts)
 * and the host enforces per RPC method (see host.ts). No capability is implied
 * by another one; holding none, a plugin can load and return, nothing else.
 * Pure module: no editor, DOM or transport imports.
 */

export const PLUGIN_CAPABILITIES = [
  'document.read',
  'document.write',
  'document.transact',
  'commands.register',
  'commands.run',
  'commands.list',
  'ui.log',
  'ui.interact',
  'events.subscribe',
  'settings.own',
  'settings.read',
  'settings.write',
  'files.read',
  'files.save',
  'electrical.read',
  'electrical.write',
] as const;

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

const KNOWN: ReadonlySet<string> = new Set(PLUGIN_CAPABILITIES);

export function isPluginCapability(value: unknown): value is PluginCapability {
  return typeof value === 'string' && KNOWN.has(value);
}

/** Parse a manifest `capabilities` value. Fail-closed: anything malformed or unknown throws. */
export function parseCapabilitySet(raw: unknown, where = 'capabilities'): ReadonlySet<PluginCapability> {
  if (raw === undefined) return new Set();
  if (!Array.isArray(raw)) throw new Error(`"${where}" must be an array of capability strings`);
  const out = new Set<PluginCapability>();
  for (const entry of raw) {
    if (!isPluginCapability(entry)) {
      throw new Error(`unknown plugin capability "${String(entry)}" in "${where}" (known: ${PLUGIN_CAPABILITIES.join(', ')})`);
    }
    out.add(entry);
  }
  return out;
}
