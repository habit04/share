/** Optional Windows host ordering, with ownership lasting through every slow save step. */
import type { FileBridge } from './editor';
import type { DrawingState } from '../core/document';
import { countOf, importReportOf, lossCount } from '../io/import-report';
import { registerWindowsPathIdentity } from './paths';

export type SaveAdmissionKind = 'drawing' | 'project' | 'export-copy';
type IdentityBridge = FileBridge & { resolvePathIdentity?(path: string): Promise<string | null> };

export const UNVERIFIED_COMMITTED_SAVE_WARNING = 'The file was replaced, but final save verification failed. Review the destination before saving again.';
export function committedSaveAdmissionError(detail: string): Error & { code: 'ERR_SAVE_COMMITTED'; detail: string } {
  return Object.assign(new Error(`ERR_SAVE_COMMITTED: ${UNVERIFIED_COMMITTED_SAVE_WARNING} ${detail}`), { code: 'ERR_SAVE_COMMITTED' as const, detail });
}
/** Electron transports error messages but drops custom fields; this marker precedes stale/OS errors. */
export function isCommittedSaveAdmissionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: unknown; message?: unknown };
  return record.code === 'ERR_SAVE_COMMITTED' || typeof record.message === 'string' && /\bERR_SAVE_COMMITTED\b|The file was written, but its committed native identity receipt is unavailable/.test(record.message);
}

export function hasSaveAdmissions(bridge: FileBridge | null): bridge is FileBridge {
  return bridge?.platform === 'win32' && typeof bridge.issueSaveAdmission === 'function' && typeof bridge.bindSaveAdmission === 'function' && typeof bridge.cancelSaveAdmission === 'function';
}

export class SaveAdmission {
  readonly enabled: boolean;
  readonly ready: Promise<void>;
  private value: string | undefined;
  private closed = false;
  private bound: string | undefined;

  constructor(private readonly bridge: FileBridge, readonly kind: SaveAdmissionKind) {
    this.enabled = hasSaveAdmissions(bridge);
    // Invoke IPC now; callers must construct this before serialization/pickers.
    let issued: Promise<string> | undefined;
    if (this.enabled) { try { issued = bridge.issueSaveAdmission!(kind); } catch (error) { issued = Promise.reject(error); } }
    this.ready = issued ? Promise.resolve(issued).then(ticket => {
      if (typeof ticket !== 'string' || !ticket || ticket.length > 256 || /[\u0000-\u001f\u007f]/.test(ticket)) throw new Error('The Windows save host returned an invalid admission.');
      this.value = ticket;
    }) : Promise.resolve();
    void this.ready.catch(() => {});
  }

  get ticket(): string | undefined { return this.value; }
  async bind(path: string): Promise<void> {
    await this.ready;
    if (!this.enabled) return;
    if (this.closed) throw new Error('This save admission has already been released.');
    if (this.bound !== undefined) { if (this.bound !== path) throw new Error('A save admission cannot be transferred to another destination.'); return; }
    const result = await this.bridge.bindSaveAdmission!(this.value!, this.kind, path);
    if (typeof result === 'string') registerWindowsPathIdentity(path, result);
    else if (result && typeof result.identityPath === 'string' && typeof result.exists === 'boolean') {
      if (result.exists) registerWindowsPathIdentity(path, result.identityPath);
    } else throw new Error('The Windows save host returned an invalid path identity.');
    this.bound = path;
  }
  /** Missing destinations become aliases only after the host created the actual leaf. */
  async confirmSaved(path: string | null): Promise<void> {
    if (!path || !this.enabled) return;
    try {
    if (this.bridge.saveAdmissionResult) {
      const receipt = await this.bridge.saveAdmissionResult(this.value!);
      if (!receipt || receipt.path !== path) throw committedSaveAdmissionError('Its committed native identity receipt is unavailable. The drawing remains modified.');
      registerWindowsPathIdentity(path, receipt.identityPath);
      return;
    }
    // Compatibility with earlier experimental bridges; the current Windows
    // host always supplies a receipt captured from the actual writer context.
    if (!this.bridge.resolvePathIdentity) return;
    const canonical = await this.bridge.resolvePathIdentity(path);
    if (canonical) registerWindowsPathIdentity(path, canonical);
    } catch (error) {
      if (isCommittedSaveAdmissionError(error)) throw error;
      throw committedSaveAdmissionError(error instanceof Error ? error.message : String(error));
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.ready; if (this.value) await this.bridge.cancelSaveAdmission!(this.value, this.kind); }
    catch { /* A consumed/expired/retired admission has no remaining reservation. */ }
  }
}

/** Never infer that an unverified recovered source is a different native file. */
export async function unverifiedImportSource(bridge: IdentityBridge, state: DrawingState): Promise<boolean> {
  const report = importReportOf(state);
  if (bridge.platform !== 'win32' || typeof bridge.resolvePathIdentity !== 'function' || !report?.sourcePath || (!report.recovered && !lossCount(report) && !(report.format === 'DWG' && countOf(report, 'unsupported')))) return false;
  const canonical = await bridge.resolvePathIdentity(report.sourcePath);
  if (!canonical) return true;
  registerWindowsPathIdentity(report.sourcePath, canonical);
  return false;
}

export const UNVERIFIED_SOURCE_WARNING = 'The original imported file\'s native identity could not be verified. This drawing contains recovered, simplified or unreadable content. The selected destination may refer to the original through another Windows path. Review the drawing and use a separate copy to preserve the original. Save to this destination anyway?';

export function isStaleSaveAdmission(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: unknown; message?: unknown };
  return record.code === 'ERR_SAVE_STALE' || (typeof record.message === 'string' && /\bERR_SAVE_STALE\b/.test(record.message));
}

export function isSaveAdmissionAuthorizationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: unknown; message?: unknown };
  return record.code === 'ERR_SAVE_AUTHORIZATION' || (typeof record.message === 'string' && /ERR_SAVE_AUTHORIZATION|not authorized|Unknown project path/.test(record.message));
}
