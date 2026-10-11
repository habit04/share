/**
 * The editor (see editor/editor.ts and the modules next to it). Every import of the Editor, its
 * types and helpers goes through here.
 */
export { backupOutcome, type EditorEvent, type CommandDef, type OpenResult, type PlotSheet, type BackupResult, type SaveErrorChoice, type FileBridge, type LegacyBackupResult } from './editor/types';
export { Editor, applyGrip } from './editor/editor';
