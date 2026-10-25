/**
 * Priority 20, slice 1 — xref commands (design D5). XREF itself is taken
 * (an alias of the electrical AEXREF), so slice 1 registers exactly two
 * commands, no panel: XREFRELOAD (manual refresh of the active document)
 * and XREFSTATUS (the node table). Both act on the ACTIVE document's
 * controller through the editor's registry; all wording of statuses is
 * the core's own — never re-worded here.
 */
import type { Editor } from './editor';
import type { XrefSessionController } from './xref-session';

function activeController(ed: Editor): XrefSessionController | undefined {
  const session = ed.sessions.current;
  if (!session) return undefined;
  return ed.xrefSessions.bind(session.docId);
}

export function registerXrefCommands(ed: Editor): void {
  ed.register({
    name: 'XREFRELOAD',
    aliases: [],
    description: 'Reload the active drawing\'s external references from disk',
    run: async (editor) => {
      const controller = activeController(editor);
      if (!controller) { editor.log('XREFRELOAD: no active drawing'); return; }
      const status = controller.status();
      if (!status.live) {
        editor.log(status.inertReason === 'unsaved-host'
          ? 'XREFRELOAD: the drawing has no saved file path (unsaved-host); references are not anchored'
          : 'XREFRELOAD: the file bridge does not expose xref methods (no-bridge)');
        return;
      }
      const result = await controller.reload();
      if (result === null) { editor.log('XREFRELOAD: no external references'); return; }
      if (result.committed) {
        editor.log(`XREFRELOAD: reloaded, generation ${controller.status().generation}`);
      } else if (result.stale || result.cancelled) {
        editor.log('XREFRELOAD: superseded by a newer attempt; the displayed graph is unchanged');
      } else {
        const first = result.failures[0];
        editor.log(`XREFRELOAD: reload did not commit (${result.failures.length} failure(s)${first ? `; first: ${first.blockName} ${first.kind}` : ''}); the last loaded graph is still displayed`);
      }
    },
  });

  ed.register({
    name: 'XREFSTATUS',
    aliases: [],
    description: 'List the active drawing\'s external references and their load status',
    run: (editor) => {
      const controller = activeController(editor);
      if (!controller) { editor.log('XREFSTATUS: no active drawing'); return; }
      const status = controller.status();
      if (!status.live) {
        editor.log(`XREFSTATUS: inactive (${status.inertReason ?? 'not live'})`);
        return;
      }
      if (status.nodes.length === 0) { editor.log('XREFSTATUS: no external references'); return; }
      for (const node of status.nodes) {
        const indent = '  '.repeat(Math.max(0, node.depth - 1));
        const resolved = node.resolvedPath && node.resolvedPath !== node.originalPath ? ` -> ${node.resolvedPath}` : '';
        const unsupported = node.unsupportedFeatures.length > 0 ? ` [unsupported: ${node.unsupportedFeatures.join(', ')}]` : '';
        const message = node.message ? ` — ${node.message}` : '';
        editor.log(`${indent}${node.blockName} ${node.status} ${node.originalPath}${resolved}${message}${unsupported}`);
      }
    },
  });
}
