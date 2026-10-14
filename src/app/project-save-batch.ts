/** Windows project writes inherit one host order captured before their source snapshots. */
import type { FileBridge, OpenResult } from './editor';
import { normalizePath, registerWindowsPathIdentities, registerWindowsPathIdentity } from './paths';
import { ProjectBatchBudget } from './project-batch-budget';
import { committedSaveAdmissionError, isCommittedSaveAdmissionError } from './save-admission';

export type ProjectBatchBinding = { index: number; path: string; childTicket: string; identityPath: string; exists: true } | { index: number; path: string; missing: true };
export interface ProjectSaveBatchBridge {
  issueProjectSaveBatch(): Promise<string>;
  bindProjectSaveBatch(batch: string, paths: string[]): Promise<ProjectBatchBinding[]>;
  openProjectSaveBatchDrawing(batch: string, childTicket: string): Promise<OpenResult>;
  sealProjectSaveBatch(batch: string, selectedChildTickets: string[]): Promise<void>;
  beginProjectSaveBatchCommit(batch: string, remainingChildren?: string[]): Promise<void>;
  cancelProjectSaveBatch(batch: string): Promise<void>;
}
type BatchBridge = FileBridge & ProjectSaveBatchBridge;
const validTicket = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const invalid = () => new Error('The Windows save host returned an invalid project admission.');

export function hasProjectSaveBatch(bridge: FileBridge | null): bridge is BatchBridge {
  return bridge?.platform === 'win32' && (['issueProjectSaveBatch', 'bindProjectSaveBatch', 'openProjectSaveBatchDrawing', 'sealProjectSaveBatch', 'beginProjectSaveBatchCommit', 'cancelProjectSaveBatch'] as const).every(key => typeof (bridge as Partial<ProjectSaveBatchBridge>)[key] === 'function') && typeof bridge.saveAdmissionResult === 'function' && typeof bridge.cancelSaveAdmission === 'function';
}

export class ProjectSaveBatch {
  readonly ready: Promise<void>;
  readonly budget = new ProjectBatchBudget();
  private value: string | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  private bound = false;
  private readonly children = new Set<ProjectBatchChild>();

  constructor(private readonly bridge: BatchBridge) {
    // Issue synchronously, before callers inspect project/session state or produce data.
    let issued: Promise<string>;
    try { issued = bridge.issueProjectSaveBatch(); } catch (error) { issued = Promise.reject(error); }
    this.ready = Promise.resolve(issued).then(ticket => { if (!validTicket(ticket)) throw invalid(); this.value = ticket; });
    void this.ready.catch(() => {});
  }
  private async ticket(): Promise<string> { await this.ready; if (this.closed || !this.value) throw new Error('This project admission has already been released.'); return this.value; }

  async bind(paths: readonly string[]): Promise<Array<ProjectBatchChild | null>> {
    const parent = await this.ticket();
    if (this.bound || paths.length > 512) throw new Error('This project contains too many closed drawings for one safe update. Use a smaller project batch.');
    this.bound = true;
    const logical = paths.map(path => normalizePath(path));
    const result = await this.bridge.bindProjectSaveBatch(parent, logical);
    if (!Array.isArray(result) || result.length !== logical.length) throw invalid();
    const records = new Map<number, ProjectBatchBinding>(), tickets = new Set<string>(), targets = new Set<string>();
    for (const record of result) {
      if (!record || !Number.isInteger(record.index) || record.index < 0 || record.index >= logical.length || records.has(record.index) || typeof record.path !== 'string' || normalizePath(record.path) !== logical[record.index]) throw invalid();
      if ('missing' in record) { if (record.missing !== true || 'childTicket' in record || 'identityPath' in record) throw invalid(); }
      else {
        if (record.exists !== true || !validTicket(record.childTicket) || tickets.has(record.childTicket) || typeof record.identityPath !== 'string') throw invalid();
        const canonical = normalizePath(record.identityPath);
        if (targets.has(canonical)) throw new Error('Multiple project drawings resolve to the same native file. Remove duplicate project entries before updating them.');
        targets.add(canonical);
        tickets.add(record.childTicket);
      }
      records.set(record.index, record);
    }
    registerWindowsPathIdentities(result.flatMap(record => 'missing' in record ? [] : [{ logical: record.path, canonical: record.identityPath }]));
    return logical.map((path, index) => {
      const record = records.get(index)!;
      if ('missing' in record) return null;
      const child = new ProjectBatchChild(this, this.bridge, path, record.childTicket, normalizePath(record.identityPath));
      this.children.add(child); return child;
    });
  }
  async read(child: ProjectBatchChild): Promise<OpenResult> {
    if (!this.children.has(child) || child.closed) throw invalid();
    const result = await this.bridge.openProjectSaveBatchDrawing(await this.ticket(), child.ticket);
    if (!result || result.kind !== 'dxf' || normalizePath(result.path) !== child.path || typeof result.text !== 'string' || typeof result.identityPath !== 'string' || normalizePath(result.identityPath) !== child.identityPath) throw invalid();
    this.budget.addSource(result.text); return result;
  }
  private selected(children: readonly ProjectBatchChild[]): string[] {
    const unique = new Set(children);
    if (unique.size !== children.length || children.some(child => !this.children.has(child) || child.closed)) throw invalid();
    return children.map(child => child.ticket);
  }
  async seal(children: readonly ProjectBatchChild[]): Promise<void> { await this.bridge.sealProjectSaveBatch(await this.ticket(), this.selected(children)); }
  async begin(children: readonly ProjectBatchChild[]): Promise<void> { await this.bridge.beginProjectSaveBatchCommit(await this.ticket(), this.selected(children)); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    // If already issued, post cancellation in the event callback itself. A second/finally
    // close must join the same host cleanup, even while its first cancellation is pending.
    let cancellation: Promise<void>;
    try { cancellation = this.value ? this.bridge.cancelProjectSaveBatch(this.value) : this.ready.then(() => this.value ? this.bridge.cancelProjectSaveBatch(this.value) : undefined); }
    catch (error) { cancellation = Promise.reject(error); }
    this.closing = Promise.resolve(cancellation).catch(() => { /* Consumed, expired or retired parent; host cleanup owns its reservations. */ });
    return this.closing;
  }
}

/** A preissued child can never be rebound or acquire a new order for an old calculation. */
export class ProjectBatchChild {
  readonly enabled = true;
  readonly ready = Promise.resolve();
  closed = false;
  constructor(readonly batch: ProjectSaveBatch, private readonly bridge: BatchBridge, readonly path: string, readonly ticket: string, readonly identityPath: string) {}
  async bind(path: string): Promise<void> { if (this.closed || normalizePath(path) !== this.path) throw new Error('A project admission cannot be transferred to another drawing.'); }
  async confirmSaved(path: string | null): Promise<void> {
    if (!path) return;
    try {
    const receipt = await this.bridge.saveAdmissionResult!(this.ticket);
    if (!receipt || receipt.path !== path || normalizePath(path) !== this.path || typeof receipt.identityPath !== 'string' || normalizePath(receipt.identityPath) !== this.identityPath) throw committedSaveAdmissionError('Its committed native identity receipt is unavailable.');
    registerWindowsPathIdentity(path, receipt.identityPath);
    } catch (error) {
      if (isCommittedSaveAdmissionError(error)) throw error;
      throw committedSaveAdmissionError(error instanceof Error ? error.message : String(error));
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.bridge.cancelSaveAdmission!(this.ticket, 'drawing'); } catch { /* Consumed/retired child. */ }
  }
}
