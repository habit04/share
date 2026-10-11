/**
 * The project: its data and the modified flag, generation and revision counters (saves bind to
 * the project that started them), Open / New / Save (As) of the project file, adding the current
 * drawing and opening the project's drawings.
 * The Editor's public methods delegate here (their documentation is on the Editor).
 */
import { parseProject, serializeProject, resolveDrawingPath, baseName, projectDrawingIndex, projectEntryFor, rebaseProject, type Project } from '../project';
import { captureRevision, saveQueue } from '../savequeue';
import { describeFileError } from '../file-errors';
import type { Editor } from './editor';
import { fallbackUi, type EditorInternals } from './internals';
import { openErrorText, rememberRecent } from './documents';

export function projectState(st: EditorInternals): { generation: number; revision: number } {
  return { generation: st.projectGen, revision: st.projectRev };
}

export function updateProject(ed: Editor, st: EditorInternals, next: Project): void {
  ed.project = next;
  st.projectRev += 1;
  ed.projectDirty = true;
  ed.hooks.projectChanged?.();
  ed.notify('project');
}

export function replaceProject(ed: Editor, st: EditorInternals, p: Project, dirty: boolean): void {
  ed.project = p;
  st.projectGen += 1;
  st.projectRev += 1;
  ed.projectDirty = dirty;
  ed.hooks.projectChanged?.();
  ed.notify('project');
}

export async function confirmDiscardProject(ed: Editor): Promise<boolean> {
  if (!ed.projectDirty) return true;
  const ui = ed.ui ?? fallbackUi;
  const label = `project ${ed.project.name}`;
  if (ui.saveChanges) {
    const r = await ui.saveChanges(label);
    if (r === 'cancel') return false;
    if (r === 'save') return (await ed.saveProject()) && !ed.projectDirty;
    return true;
  }
  return ui.confirm('Unsaved project changes', `The ${label} has unsaved changes. Discard them?`);
}

export async function openProject(ed: Editor, st: EditorInternals, file: string | undefined, opts: { userChosen?: boolean }): Promise<boolean> {
  if (!ed.fileBridge?.openProject) {
    ed.log('Projects need the desktop app.');
    return false;
  }
  if (!(await ed.confirmDiscardProject())) return false;
  const answered = st.projectRev;
  try {
    const res = await ed.fileBridge.openProject(file, file && opts.userChosen ? { userChosen: true } : undefined);
    if (!res) return false;
    // Changes made to the project while the Open dialog was up get their own question.
    if (ed.projectDirty && st.projectRev !== answered && !(await ed.confirmDiscardProject())) return false;
    ed.replaceProject(parseProject(res.text, res.path));
    ed.log(`Project ${ed.project.name}: ${ed.project.drawings.length} drawing(s).`);
    rememberRecent(ed, res.path);
    ed.notify('file');
    return true;
  } catch (err) {
    ed.lastFileError = openErrorText(err, file);
    ed.log(`Failed to open project: ${ed.lastFileError}`);
    return false;
  }
}

export async function newProjectCommand(ed: Editor, st: EditorInternals, name?: string): Promise<boolean> {
  if (!(await ed.confirmDiscardProject())) return false;
  const answered = st.projectRev;
  let n = name?.trim();
  if (!n) {
    const typed = await (ed.ui ?? fallbackUi).textInput('New Project', 'Project name:', 'Project1');
    if (typed === null) return false;
    n = typed.trim() || 'Project1';
  }
  // The project may have been changed again while the name was asked for.
  if (ed.projectDirty && st.projectRev !== answered && !(await ed.confirmDiscardProject())) return false;
  ed.replaceProject({ name: n, drawings: [] });
  ed.log(`New project ${n}. Add drawings with PROJECTADD and write the project file with PROJECTSAVE.`);
  ed.notify('file');
  return true;
}

export function addCurrentToProject(ed: Editor): void {
  if (!ed.doc.filePath) {
    ed.log('Save the drawing first, then add it to the project.');
    return;
  }
  if (projectDrawingIndex(ed.project, ed.doc.filePath) >= 0) {
    ed.log('Drawing is already in the project.');
    return;
  }
  const file = projectEntryFor(ed.project, ed.doc.filePath);
  ed.updateProject({ ...ed.project, drawings: [...ed.project.drawings, { file }] });
  ed.log(`Added ${baseName(file)} to project ${ed.project.name}. Use PROJECTSAVE to write the project file.`);
  ed.notify('file');
}

export async function saveProject(ed: Editor, st: EditorInternals, saveAs: boolean): Promise<boolean> {
  const bridge = ed.fileBridge;
  const direct = !!(bridge?.saveProject && bridge.chooseProjectPath);
  if (!bridge || (!direct && !bridge.saveText)) {
    ed.log('Projects need the desktop app.');
    return false;
  }
  const gen = st.projectGen;
  const rev = st.projectRev;
  const snapshot = ed.project;
  const revision = captureRevision();
  const suggest = snapshot.path ?? `${snapshot.name.replace(/\s+/g, '_')}.jcadproj.json`;
  ed.lastFileError = null;
  let written: { path: string; project: Project };
  try {
    if (direct) {
      let dest = !saveAs && snapshot.path ? snapshot.path : await bridge.chooseProjectPath!(suggest);
      if (!dest) return false;
      const write = (to: string) => saveQueue.run(to, revision, () => bridge.saveProject!(to, serializeProject(rebaseProject(snapshot, to))));
      let r;
      try {
        r = await write(dest);
      } catch (err) {
        // A path the main process does not know (a recovered project from another session): ask where to save.
        if (!/Unknown project path/.test((err as Error).message) || saveAs) throw err;
        dest = await bridge.chooseProjectPath!(suggest);
        if (!dest) return false;
        r = await write(dest);
      }
      const out = rebaseProject(snapshot, dest);
      if (r.status === 'stale') {
        ed.lastFileError = `a newer version of ${dest} was saved meanwhile`;
        return false;
      }
      if (!r.value) return false;
      written = { path: r.value, project: r.value === dest ? out : rebaseProject(snapshot, r.value) };
    } else {
      // Older bridge / browser: the save dialog (or a download) picks the name; entries are written as they are.
      const p = await bridge.saveText!(suggest, serializeProject(snapshot), 'JCad Electrical Project', 'json');
      if (!p) return false;
      saveQueue.markCompleted(p, revision);
      written = { path: p, project: { ...snapshot, path: p } };
    }
  } catch (err) {
    // Nothing is marked as saved; the project stays modified (and autosaved). Retry / Save As... come from the save error dialog.
    const info = describeFileError(err, { action: 'save', path: snapshot.path });
    ed.lastFileError = info.message;
    ed.log(`Project not saved: ${info.message}`);
    const choice = ed.hooks.saveError ? await ed.hooks.saveError(info, snapshot.name, { saveAs: true }) : 'cancel';
    if (choice === 'cancel' || st.projectGen !== gen) return false;
    return ed.saveProject(choice === 'saveas' ? true : saveAs);
  }
  if (st.projectGen !== gen) {
    ed.log(`Project ${snapshot.name} saved: ${written.path} (another project is open now; it is unchanged).`);
    return true;
  }
  if (st.projectSavedRevision > revision) {
    ed.log(`Project ${snapshot.name} saved: ${written.path} (a newer save completed meanwhile; the current project keeps that destination).`);
    rememberRecent(ed, written.path);
    return true;
  }
  st.projectSavedRevision = revision;
  if (st.projectRev === rev) {
    ed.project = written.project;
    ed.projectDirty = false;
    ed.log(`Project saved: ${written.path}`);
  } else {
    // Edits made while the file was written stay (unsaved), re-expressed for the new location.
    ed.project = rebaseProject(ed.project, written.path);
    ed.projectDirty = true;
    ed.log(`Project saved: ${written.path} (changes made during the save are still unsaved).`);
  }
  rememberRecent(ed, written.path);
  ed.hooks.projectChanged?.();
  ed.notify('project');
  return true;
}

export function openProjectDrawing(ed: Editor, index: number): void {
  const d = ed.project.drawings[index];
  if (!d) return;
  void ed.openFile(resolveDrawingPath(ed.project, d));
}
