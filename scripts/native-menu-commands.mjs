/** Collect commands from the production native menu under an explicit platform. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

export function nativeMenuCommands(platform) {
  const menuFile = new URL('../electron/main/menu.cjs', import.meta.url);
  const require = createRequire(menuFile);
  const commands = [];
  let template = [];
  /** @type {((event: object, files: string[]) => void) | undefined} */
  let recentListener;
  const win = { webContents: { send: (channel, command) => {
    if (channel !== 'menu-command' || typeof command !== 'string') throw new Error('Unexpected native menu dispatch.');
    commands.push(command);
  } } };
  const electron = {
    app: { isPackaged: true, getVersion: () => 'menu-audit' },
    BrowserWindow: { fromWebContents: () => win },
    Menu: { buildFromTemplate: (items) => items, setApplicationMenu: (items) => { template = items; } },
    shell: { openExternal: () => {} },
  };
  const module = { exports: /** @type {{ registerMenuIpc(ctx: object): void }} */ ({}) };
  const load = (name) => name === 'electron' ? electron : name === '../updater.cjs'
    ? { checkForUpdates: () => {}, RELEASES_PAGE: 'https://github.com/habit04/share/releases' }
    : require(name);
  // Execute the same platform branches and callbacks as Electron without changing Node's
  // process.platform or performing updater/link actions during an audit.
  new Function('require', 'module', 'process', readFileSync(menuFile, 'utf8'))(load, module, { platform });
  const ctx = {
    registry: { isWritable: () => true }, handedOverProjects: new Set(),
    ipcMain: { on: (channel, listener) => {
      if (channel !== 'set-recent-files') throw new Error('Unexpected native menu listener.');
      recentListener = listener;
    } },
  };
  module.exports.registerMenuIpc(ctx);
  if (typeof recentListener !== 'function') throw new Error('The native Recent menu listener is missing.');
  // Exercise the populated Recent submenu as well as the fixed menu items.
  recentListener({ sender: win.webContents }, ['C:/menu-audit/drawing.dxf', 'C:/menu-audit/project.jcadproj.json']);
  const visit = (items) => {
    for (const item of items) {
      if (Array.isArray(item.submenu)) visit(item.submenu);
      if (typeof item.click === 'function') item.click();
    }
  };
  visit(template);
  return commands;
}
