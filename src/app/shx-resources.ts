import { DrawingShxResources } from '../render/drawing-shx';
import type { DocumentSession } from './sessions';
import type { Editor } from './editor';

/** Session identity, rather than STYLE identity or basename, owns selected runtime programs. */
export class SessionShxResources {
  private readonly entries = new WeakMap<DocumentSession, { generation: number; resources: DrawingShxResources }>();
  constructor(private readonly changed: (session: DocumentSession) => void = () => {}) {}
  for(session: DocumentSession): DrawingShxResources {
    let entry = this.entries.get(session);
    if (!entry || entry.generation !== session.contentGeneration) {
      entry = { generation: session.contentGeneration, resources: new DrawingShxResources(() => this.changed(session)) };
      this.entries.set(session, entry);
    }
    return entry.resources;
  }
}

/** Native choices alone authorize reads. The selected program does not modify STYLE or dirty state. */
export function registerShxCommand(ed: Editor): void {
  ed.register({ name: 'SHXFONT', aliases: ['SHXLOAD'], description: 'Load an SHX font or shape file for this drawing tab', async run(editor) {
    const choose = editor.fileBridge?.openShxFont;
    if (editor.fileBridge?.platform !== 'win32' || !choose) { editor.log('SHX resource loading is available in the Windows desktop app.'); return; }
    const session = editor.sessions.current, generation = session.contentGeneration;
    try {
      const resource = await choose(); if (!resource) return;
      const stillOpen = () => editor.sessions.all.some((entry) => entry === session && entry.contentGeneration === generation);
      if (!stillOpen()) { editor.log('The drawing was closed or replaced while choosing its SHX resource.'); return; }
      const loaded = await editor.shxResources.for(session).load(resource);
      if (!stillOpen()) return;
      if (!loaded.applied) { editor.log('A newer SHX selection for this filename was kept.'); return; }
      editor.log(`Loaded ${loaded.filename} for this drawing tab. ${loaded.problem || (loaded.isFont ? 'Matching STYLE filenames use its supported glyphs; unsupported runs retain the substitute.' : 'Shape definitions are retained as runtime resources; embedded linetype display is still pending.')}`);
    } catch (error) { editor.log(`SHX resource could not be loaded: ${error instanceof Error ? error.message : String(error)}`); }
  } });
}
