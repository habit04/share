/**
 * Text for the user about a failed file operation (save, backup, read). One place to turn a
 * bridge / main-process error into a message, so the save paths (SAVE, PROJECTSAVE, project-wide
 * writes, CSV export, Save All) report failures the same way: describeFileError's message.
 */
import { describeFileError } from './file-errors';
import { isCommittedSaveAdmissionError, UNVERIFIED_COMMITTED_SAVE_WARNING } from './save-admission';

export interface FileErrorContext {
  action: 'save' | 'read';
  path?: string | null;
}

export function fileErrorText(err: unknown, ctx: FileErrorContext = { action: 'save' }): string {
  return describeFileError(err, { action: ctx.action, path: ctx.path }).message;
}

/**
 * Why an export (CSV, report, .wdt) was not saved, naming the file and folder the user picked in
 * the Save dialog (the error carries that path; `name` is only the suggested name).
 */
export function exportErrorText(err: unknown, name: string): string {
  if (isCommittedSaveAdmissionError(err)) return UNVERIFIED_COMMITTED_SAVE_WARNING;
  const info = describeFileError(err, { action: 'save' });
  return info.path ? info.message : fileErrorText(err, { action: 'save', path: name });
}

/**
 * Catch handler for a text export (CSV, report, .wdt): logs why `name` was not saved and resolves
 * null, instead of leaving an unhandled rejection.
 */
export function exportFailed(log: (text: string) => void, name: string): (err: unknown) => null {
  return (err) => {
    log(`${isCommittedSaveAdmissionError(err) ? 'Export verification failed' : 'Export not saved'}: ${exportErrorText(err, name)}`);
    return null;
  };
}
