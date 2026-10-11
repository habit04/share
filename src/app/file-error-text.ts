/**
 * Text for the user about a failed file operation (save, backup, read). One place to turn a
 * bridge / main-process error into a message, so the save paths (SAVE, PROJECTSAVE, project-wide
 * writes, CSV export, Save All) report failures the same way.
 */
export interface FileErrorContext {
  action: 'save' | 'read';
  path?: string | null;
}

export function fileErrorText(err: unknown, _ctx: FileErrorContext = { action: 'save' }): string {
  if (err instanceof Error) return err.message || 'unknown error';
  return err ? String(err) : 'unknown error';
}
