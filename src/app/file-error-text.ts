/**
 * Text for the user about a failed file operation (save, backup, read). One place to turn a
 * bridge / main-process error into a message, so the save paths (SAVE, PROJECTSAVE, project-wide
 * writes, CSV export, Save All) report failures the same way: describeFileError's message.
 */
import { describeFileError } from './file-errors';

export interface FileErrorContext {
  action: 'save' | 'read';
  path?: string | null;
}

export function fileErrorText(err: unknown, ctx: FileErrorContext = { action: 'save' }): string {
  return describeFileError(err, { action: ctx.action, path: ctx.path }).message;
}

/**
 * Catch handler for a text export (CSV, report, .wdt): logs why `name` was not saved and resolves
 * null, instead of leaving an unhandled rejection.
 */
export function exportFailed(log: (text: string) => void, name: string): (err: unknown) => null {
  return (err) => {
    log(`${name} not saved: ${fileErrorText(err, { action: 'save', path: name })}`);
    return null;
  };
}
