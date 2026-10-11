import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { readSource } from './helpers/main-process';

function loadMainModule<T>(file: string, imports: Record<string, unknown>): T {
  const module = { exports: {} };
  const localRequire = createRequire(resolve(file));
  new Function('require', 'module', '__dirname', readSource(file))(
    (name: string) => Object.hasOwn(imports, name) ? imports[name] : localRequire(name),
    module,
    dirname(resolve(file)),
  );
  return module.exports as T;
}

interface MenuItem {
  label?: string;
  role?: string;
  click?: () => void;
  submenu?: MenuItem[];
}

describe('main-process security across modules', () => {
  it('only a native Recent click gives a writable project one consumable grant', () => {
    const callbacks = new Map<string, (event: unknown, files: string[]) => void>();
    const commands: string[] = [];
    let template: MenuItem[] = [];
    const win = { webContents: { send: (_channel: string, command: string) => commands.push(command) } };
    const electron = {
      app: { isPackaged: true, getVersion: () => '0.4.1', on: () => {} },
      BrowserWindow: { fromWebContents: () => win },
      Menu: { buildFromTemplate: (items: MenuItem[]) => items, setApplicationMenu: (items: MenuItem[]) => { template = items; } },
    };
    const project = resolve('native-project.jcadproj.json');
    const readOnly = resolve('read-only-project.jcadproj.json');
    const drawing = resolve('native-drawing.dxf');
    const { createPathRegistry } = createRequire(import.meta.url)('../electron/path-registry.cjs') as {
      createPathRegistry(): { grant(file: string): void; grantRead(file: string): void; isWritable(file: string): boolean };
    };
    const registry = createPathRegistry();
    registry.grant(project);
    registry.grantRead(readOnly);
    registry.grant(drawing);
    const ctx = {
      ipcMain: {
        on: (name: string, callback: (event: unknown, files: string[]) => void) => callbacks.set(name, callback),
        handle: () => {},
      },
      registry,
      handedOverProjects: new Set<string>(),
      mainWindow: null,
      openFilesReady: false,
    };
    const { registerMenuIpc } = loadMainModule<{ registerMenuIpc(ctx: unknown): void }>('electron/main/menu.cjs', {
      electron,
      '../updater.cjs': { canSelfUpdate: () => false },
    });
    const { createHandover } = loadMainModule<{ createHandover(ctx: unknown): { takeHandedOverProject(file: string): boolean } }>('electron/main/handover.cjs', { electron });
    const { takeHandedOverProject } = createHandover(ctx);
    registerMenuIpc(ctx);
    callbacks.get('set-recent-files')!({ sender: {} }, [project, readOnly, drawing]);
    expect(takeHandedOverProject(project)).toBe(false);
    const fileMenu = template.find((item) => item.label === 'File')!;
    const recent = fileMenu.submenu!.find((item) => item.label === 'Open Recent')!.submenu!;
    recent[0]!.click!();
    expect(takeHandedOverProject(project)).toBe(true);
    expect(takeHandedOverProject(project)).toBe(false);
    recent[1]!.click!();
    recent[2]!.click!();
    expect(takeHandedOverProject(readOnly)).toBe(false);
    expect(takeHandedOverProject(drawing)).toBe(false);
    expect(commands).toEqual(['RECENT 1', 'RECENT 2', 'RECENT 3']);
    expect(template.find((item) => item.label === 'View')!.submenu!.some((item) => item.role === 'toggleDevTools')).toBe(false);
  });

  it('reports failed preference flushes so a migration is not marked complete', () => {
    const logs: string[] = [];
    const { flushRendererPreferences } = loadMainModule<{ flushRendererPreferences(contents: unknown): boolean }>('electron/main/app-data.cjs', {
      electron: { app: { getPath: () => resolve('private-test-data') } },
      'node:fs': { mkdirSync: () => {}, appendFileSync: (_file: string, line: string) => logs.push(line) },
    });
    let flushes = 0;
    expect(flushRendererPreferences({ session: { flushStorageData: () => { flushes += 1; } } })).toBe(true);
    expect(flushes).toBe(1);
    expect(flushRendererPreferences({ session: { flushStorageData: () => { throw new Error('storage unavailable'); } } })).toBe(false);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('renderer preference persistence');
    expect(logs[0]).toContain('storage unavailable');
    expect(readSource('electron/main.cjs')).toContain('rendererStorage === null || !flushRendererPreferences(event.sender)');
  });
});
