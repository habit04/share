/**
 * The main process's sources for the static checks: electron/main.cjs, the entry, and the modules
 * it wires (electron/main/*.cjs).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');

/** Repository-relative paths of the main-process files: the entry first, then electron/main/ by name. */
export function mainProcessFiles(): string[] {
  const dir = join(root, 'electron', 'main');
  const modules = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.cjs')).sort() : [];
  return ['electron/main.cjs', ...modules.map((f) => `electron/main/${f}`)];
}

/** The text of a repository file. */
export function readSource(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

/** Every main-process source, one after the other. */
export function mainProcessSource(): string {
  return mainProcessFiles().map(readSource).join('\n');
}

/**
 * The IPC handler registered for `channel`: from its `ipcMain.handle('<channel>'` to the next
 * `ipcMain.handle(` of the same file (or the end of that file); '' when no file registers it.
 */
export function ipcHandlerSource(channel: string): string {
  const mark = `ipcMain.handle('${channel}'`;
  for (const file of mainProcessFiles()) {
    const src = readSource(file);
    const start = src.indexOf(mark);
    if (start < 0) continue;
    const next = src.indexOf('ipcMain.handle(', start + 10);
    return src.slice(start, next < 0 ? undefined : next);
  }
  return '';
}
