/**
 * P25 plugin capability isolation — public surface of the isolated modules.
 * PROPOSAL-P25 was ADMITTED (LEDGER L-011); src/app/plugins.ts imports the
 * modules directly for the PluginHost wiring (see docs/PLUGIN-ISOLATION.md).
 */
export { PLUGIN_CAPABILITIES, isPluginCapability, parseCapabilitySet, type PluginCapability } from './capabilities';
export { parseIsolatedManifest, IsolatedManifestError, type IsolatedManifest } from './manifest';
export { ISOLATED_API_VERSION, MAX_MESSAGE_BYTES, type RpcErrorCode, type RpcFailure } from './protocol';
export { IsolatedPluginSession, type RealmTransport, type IsolatedSessionOptions, type DenialRecord } from './host';
export { REALM_BOOTSTRAP_SOURCE, realmBootstrapMain } from './realm-bootstrap';
export { browserWorkerTransport } from './browser-transport';
