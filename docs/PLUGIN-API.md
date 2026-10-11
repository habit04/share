# Plugin and scripting API

JCad Electrical can be extended with JavaScript: **plugins** add commands and react to
events, **scripts** (SCRIPTRUN) are one-off programs run against the open drawing, and the
same API is available in the developer console as `window.jcadApi` (in the browser edition and
in development builds; installed builds have no developer tools).

- API version: **1** (`jcad.apiVersion`). Additions keep the version; an incompatible
  change bumps it, and a plugin that declares a newer `apiVersion` than the app provides is
  refused with a message instead of half-working.
- Everything the API hands out is a **frozen copy**. To change the drawing you pass entities
  back through `document.add / replace / remove` or group changes with `document.transact`;
  every change is an undo step like any command (Ctrl+Z works).
- Accepted drawing snapshots are also sealed at runtime. Build replacement objects instead of
  mutating objects retained by the drawing. Geometry budgets apply to edits and project batches:
  an oversized candidate throws before it changes document state, undo history or dirty status.
  `commands.run` returns an asynchronous command's promise, so scripts can await a rejection.
- Errors thrown by plugin code (while loading, in a command, in an event listener, in a
  rejected promise, in a timer or other callback whose stack points into the plugin) are
  caught and printed on the command line as `[plugin-name] ...`, and one plugin that fails to
  load does not stop the others from loading. This is error reporting, not isolation: plugins
  run in the application page itself (see [Security](#security)), so a plugin that loops
  forever, exhausts memory or deliberately breaks the page's globals can still freeze or break
  the editor.

Contents: [Quick start](#quick-start) · [Packaging](#packaging-a-plugin) ·
[Lifecycle](#lifecycle) · [Commands](#commands) · [Security](#security) ·
[Capabilities](#capabilities) · [Isolation options](#isolation-options-for-the-future) ·
[API reference](#api-reference) · [Entities](#entity-objects) · [Examples](#examples)

## Quick start

`plugins/hello/plugin.json`

```json
{ "name": "hello", "version": "1.0.0", "description": "Says hello", "main": "main.js", "apiVersion": 1 }
```

`plugins/hello/main.js`

```js
jcad.commands.register({
  name: 'HELLO',
  description: 'Say hello and report the selection count',
  run(jcad) {
    const n = jcad.document.selection().length;
    jcad.ui.log(`Hello! ${n} object(s) selected.`);
  },
});
```

The file body runs once when the plugin loads. `jcad` is its only parameter; there is no
`require`, no `import` and no Node.js (the window is a sandboxed renderer).

## Packaging a plugin

A plugin is a folder:

```
<app data>/plugins/
  hello/
    plugin.json
    main.js
```

`<app data>` is the application's data folder (Windows `%APPDATA%\JCad Electrical`,
macOS `~/Library/Application Support/JCad Electrical`, Linux `~/.config/JCad Electrical`).
Type **PLUGINS** to print the exact path; the `plugins` folder is created the first time.

`plugin.json`:

| Field         | Required | Meaning                                                                 |
| ------------- | -------- | ----------------------------------------------------------------------- |
| `name`        | yes*     | 1-64 letters, digits, `.`, `-`, `_`. Defaults to the folder name.        |
| `main`        | no       | Entry file in the same folder (default `main.js`). No sub-folders.      |
| `version`     | no       | Shown by PLUGINS.                                                        |
| `description` | no       | Shown by PLUGINS.                                                        |
| `author`      | no       | Informational.                                                           |
| `apiVersion`  | no       | API version the plugin was written for (default 1).                     |

Limits: `plugin.json` up to 64 KB, the main file up to 2 MB, one file per plugin. Bundle
your code into that one file if you use several modules (any bundler with an IIFE output
works; the bundle may refer to the free variable `jcad`).

To distribute a plugin, zip the folder; users unzip it into `<app data>/plugins/` and
restart or type `PLUGINRELOAD`.

**Browser edition** (no data folder): `PLUGINLOAD` opens a file picker. Pick one `.js`
file (the plugin is named after the file) or `plugin.json` together with its main file.
Plugins loaded this way last until the page is closed.

## Lifecycle

1. **Start-up.** Every folder in `<app data>/plugins` with a `plugin.json` is loaded, in
   folder-name order. A plugin not trusted yet asks first (see [Security](#security)).
2. **Load.** The main file runs with `jcad`. Register commands and event listeners here.
   If it returns a promise, loading waits for it (up to 30 seconds). If it throws, the
   promise rejects or it does not settle in time, everything the plugin registered so far is
   removed, PLUGINS shows the error, and the next plugin loads as usual.
3. **Running.** Commands you registered appear in HELP and command completion and run like
   built-in ones (Enter repeats them). Async `run` functions are fine.
4. **Unload / reload.** `PLUGINRELOAD [name]` reads the folder again and reloads it;
   `PLUGINS Unload <name>` unloads. Before that, functions given to
   `jcad.plugin.onUnload(fn)` run, then the plugin's commands and listeners are removed.
   Clean up anything else you created (timers, DOM elements) in `onUnload`.

## Commands

| Command                       | What it does                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `PLUGINS`                     | Lists plugins (version, status, source, commands, errors) and the folder.      |
| `PLUGINS Unload <name>`       | Unloads a plugin for this session.                                             |
| `PLUGINS Forget [<name>]`     | Forgets remembered Load / Don't Load answers (all, or one plugin's).           |
| `PLUGINLOAD [<folder>]`       | Desktop: loads `<app data>/plugins/<folder>` (asks again if declined before). Without a name, or in the browser: pick the files. |
| `PLUGINRELOAD [<name>]`       | Reloads one plugin, or all of them plus folders added since start-up.         |
| `SCRIPTRUN`                   | Picks a `.js` file and runs it once against the API (AutoCAD's SCRIPT, in JavaScript). Same confirmation as plugins. Commands a script registers stay until the app closes. |

## Security

Plugins execute **in the application page**, the same JavaScript realm as the editor's own
code, with access to every global of that page: `window`, the DOM, `localStorage`, the
running editor (`window.editor`, `window.jcadApi`) and the desktop bridge (`window.jcad`).
The `jcad` object handed to a plugin is the supported, versioned way in; nothing stops a
plugin from reaching past it. Treat a plugin like any program you install: it has the
application's rights. What that means in practice is listed under
[Capabilities](#capabilities).

What a plugin **cannot** do, because the page itself cannot:

- use Node.js (`require`, `process`, the file system): the window is a sandboxed renderer with
  context isolation;
- read or write arbitrary files: every file access goes through the main process, which only
  serves the paths listed under [Capabilities](#capabilities) and checks every request
  (absolute path, no NUL byte, inside the allowed folders, symbolic links resolved);
- talk to other web sites: the page's Content-Security-Policy (`default-src 'self'`) allows
  connections to the application only;
- use the bridge from another window or frame: the main process accepts IPC only from the
  application page in the main window's top frame (`electron/ipc-guard.cjs`) and logs refusals
  in `<app data>/ipc-rejections.log`.

Before a plugin (or script) runs the first time the user is asked:

> Load plugin *name* from *path*? Plugins run with full access to your drawings.

The answer is remembered in the renderer's `localStorage` under **`jcad.plugins.trusted`**:
a JSON object keyed by `"<origin>:<path>"` (`folder:`, `file:` or `script:`) holding
`{ answer: "yes" | "no", hash, at }`, where `hash` is the SHA-256 of the code. When the code
changes the user is asked again. A "no" is kept at start-up (the plugin is listed as
*declined*); `PLUGINLOAD <folder>` asks again. `PLUGINS Forget` clears answers.

Only a 64-hex SHA-256 digest can persist approval. If WebCrypto is unavailable, approval is
requested for that run and is not saved. The desktop's secure `jcad://app` origin provides
WebCrypto without giving plugins Node integration. Plugins still have full renderer and bridge
access after approval; the trust prompt does not create a capability sandbox.

Plugin settings written with `jcad.settings.set('plugin:<key>', value)` live in
`localStorage` under `jcad.plugins.settings.<plugin name>`.

How the code is run: the renderer calls `new Function('jcad', code)`. The desktop window's
Content-Security-Policy does not allow that (no `'unsafe-eval'`), so there the code is
handed to the preload bridge (`pluginsEval`, Electron `webFrame.executeJavaScript`) and runs
in the page with the same single `jcad` argument. The main process only lists and reads
plugin folders (`plugins-list`, `plugins-read`, `plugins-dir`); names are checked so a plugin
cannot point outside its own folder (folder names are checked, and a folder or file that is a
symbolic link leading outside the plugins folder is refused).

Only install plugins from people you trust, as you would any program.

**Trust model (decision, security review E-10).** A plugin is trusted code: once the user
answers *Load*, it runs in the application page with the same access as the application's own
code - every open drawing, the user interface, `localStorage` (including the trust answers)
and the desktop bridge with everything listed under [Capabilities](#capabilities). The prompt
is the only gate; it is not a sandbox, and `pluginsEval` (the preload's
`webFrame.executeJavaScript`) is as powerful as the plugin system itself. Signed plugins (a
publisher key pinned in the application, like catalog packs) and isolated plugins (below) are
out of scope for now; they would be an API version change. The main process still limits what
any page script can do: no Node.js, file access only through the checked IPC channels, no
network, no other windows.

## Capabilities

A loaded plugin (or SCRIPTRUN script) can:

| Area | Through the `jcad` API | Directly, as code in the page |
| --- | --- | --- |
| Drawings | Read every entity, layer, block and header of the active drawing; add, replace and remove entities (undoable); run any command. | Reach `window.editor`: every open tab, the undo history, settings, the viewport. |
| User interface | Command-line prompts, point and object picks, message boxes, modal dialogs. | Change or overlay any part of the page's DOM. |
| Files the user picks | `files.readText` (a file the user chooses in the picker). | The bridge's save dialogs (`window.jcad.saveDxf`, `saveText`, `savePdf`): the user picks the target. |
| Files the user already opened | None. A project a plugin opens by path (`commands.run('OPENPROJECT', path)`, or `RECENT` run through `commands.run`) counts as opened by name: only the drawings inside its folder become writable. | Save over a drawing or project the user opened or saved through the dialogs (`saveDxf`), or a drawing listed by a project the user opened, copy it to `.bak` (`backupFile`), reopen it by path (`openDrawing`). |
| Images | None. | Read image files (`.png`, `.jpg`, `.gif`, `.bmp`, `.webp`) in the folder or sub-folders of a file the user chose, or named by a drawing the user opened (`readImage`). |
| Application data folder | `settings.get / set` for its own keys. | Read and write autosave copies, the user symbol library, catalog packs and the other plugins' code (`autosave*`, `userLibrary*`, `packs*`, `pluginsRead`); read and change `localStorage`, including the trust answers under `jcad.plugins.trusted`. |
| Links | None. | Open this project's GitHub pages and the donation page in the system browser (`openExternal`). |
| Application | None. | Ask to quit (`quit`), check for updates. |

Not available at all: Node.js, other files or folders, network access, other processes.

## Isolation options for the future

Plugins share the page today because that keeps the API synchronous and simple (a plugin
can read the drawing and draw previews without message round trips). Stronger isolation is
possible and would be an API version change:

- **Web Worker per plugin.** The plugin runs in a worker with no DOM and no `window.jcad`;
  the `jcad` API becomes asynchronous messages that the page validates. A runaway plugin can
  be terminated without touching the editor. Prompts and dialogs would be described as data
  and rendered by the page.
- **Sandboxed iframe or a separate `BrowserView`** with its own (empty) preload, for plugins
  that need their own UI; the page talks to it with `postMessage` only.
- **Permissions in `plugin.json`** (for example `"permissions": ["document.write", "files.read"]`),
  shown in the trust prompt and enforced by the API host, so a report plugin cannot edit and a
  drawing tool cannot read files.
- **Signed plugins**, using the same Ed25519 scheme as catalog packs (docs/CATALOG-PACKS.md),
  so a changed plugin is detected by signature rather than only by its hash.

## API reference

In the signatures below `Point` is `{ x, y }` in drawing units, angles are radians and
`Bounds` is `{ min: Point, max: Point }`.

### Top level

| Member          | Description                                                        |
| --------------- | ------------------------------------------------------------------ |
| `apiVersion`    | `1`                                                                |
| `version`       | Application version, e.g. `"0.4.0"`.                               |
| `plugin.name`   | This plugin's name (`"console"` for `window.jcadApi`, `"script:<file>"` for SCRIPTRUN). |
| `plugin.onUnload(fn)` | Run `fn` when the plugin is unloaded or reloaded.            |

### `jcad.commands`

| Member | Description |
| --- | --- |
| `register({ name, aliases?, description?, override?, run(jcad, arg) })` | Adds a command. Names are letters, digits, `_ . -` (upper-cased). `arg` is the rest of the command line (`NUMLABEL A 5` gives `"A 5"`), or `undefined`. Registering a name that already exists throws unless it is your own command (reload) or you pass `override: true` to replace a built-in. Returns a function that unregisters it. |
| `run(name, arg?)` | Runs any command as if typed (`jcad.commands.run('ZOOM', 'E')`). |
| `list()` | `[{ name, aliases, description, plugin? }]` for every command. |

### `jcad.document`

| Member | Description |
| --- | --- |
| `info()` | `{ fileName, filePath, dirty }` of the active drawing. |
| `entities(filter?)` | All entities, or those matching `{ type?, layer? }`. |
| `entity(id)` | One entity or `null`. |
| `selection()` / `select(ids)` | Current selection ids / replace the selection (unknown ids are dropped; returns the ids selected). |
| `add(entityOrArray)` | Adds entities, returns their ids. `id`, `layer` (current layer) and `color` (`"ByLayer"`) are filled in; missing layers are created. |
| `replace(entityOrArray)` | Replaces entities by `id` (the type cannot change). Usual pattern: `replace({ ...jcad.document.entity(id), text: 'NEW' })`. |
| `remove(idOrIds)` | Removes entities, returns how many. |
| `transact(fn)` | Runs `fn` synchronously; every add/replace/remove/setAttributes inside becomes **one** undo step. Reads inside `fn` see the pending changes. If `fn` throws nothing is changed. Do not `await` inside (prompt first, then transact). |
| `layers()` / `currentLayer()` | Layer table (`{ name, color, visible, locked, lineWeight, linetype?, frozen? }`) / current layer name. |
| `blocks()` | Block definitions (`{ name, basePoint, entities, attributes, description? }`). |
| `extents()` | Bounds of the visible entities or `null`. |
| `header()` | Drawing header: `units`, `ltscale`, `limits`, `dimStyle`, `linetypes`, `views` ... |
| `undo()` / `redo()` | Like U / REDO; return whether something was undone. |

### `jcad.electrical`

| Member | Description |
| --- | --- |
| `components()` | Block inserts that carry a `TAG1` attribute (the schematic components). Read `c.attributes.TAG1`, `MFG`, `CAT`, `DESC1` ... |
| `wires()` | Wire lines (lines on `WIRES*` layers). |
| `setAttributes(id, { TAG: value, ... })` | Sets attribute values on an insert (tags are upper-cased, values become strings; new tags are added to the block definition). One undo step, or part of `transact`. |
| `crossReference()` | Updates coil/contact cross-references (AEXREF) and returns the number of tags. Not inside `transact`. |

### `jcad.ui`

| Member | Description |
| --- | --- |
| `log(message)` | Prints a line in the command history (non-strings are JSON). |
| `prompt(text, default?)` | Command-line text prompt. Resolves the typed text (Enter alone gives `default` or `""`), `null` on Esc. Spaces are part of the answer. |
| `pick.point(prompt?)` | Resolves a picked or typed point (snaps, ortho and `@dx,dy` work), `null` on Enter/Esc. |
| `pick.entities(prompt?)` | Runs "Select objects:" (window, crossing, ALL ...); resolves the ids (`[]` on Esc). |
| `alert(message, title?)` | Message box; resolves when closed. |
| `confirm(message, title?)` | Yes / No box; resolves `true` for Yes. |
| `openDialog(htmlOrOptions)` | Modal dialog. Options: `{ title?, html?, text?, width?, buttons?: string[], onOpen?(body, close) }`. Resolves the label of the clicked button, or `null` when closed with Esc / ×. `onOpen` receives the body element so you can wire your own inputs, and `close(result)`. |

Prompts are commands in their own right: starting another command (or pressing Esc)
cancels a pending prompt, which then resolves `null`.

### `jcad.events`

`on(event, fn)` returns an unsubscribe function; `off(event, fn)` removes a listener.

| Event | Payload | When |
| --- | --- | --- |
| `documentChanged` | – | Any change to the active drawing (including undo/redo and tab switches). |
| `selectionChanged` | `string[]` ids | The selection changed. |
| `commandStarted` | command name | A command was started from the command line, menu, ribbon or `commands.run`. |
| `commandEnded` | command name | The command finished or was cancelled (for commands with prompts: when their prompts end). |
| `drawingOpened` | `{ fileName, filePath }` | A drawing was opened, created or its tab activated. |

Listeners should be quick; they run synchronously after the change.

### `jcad.settings`

| Member | Description |
| --- | --- |
| `get(key)` | Readable application settings: `gridVisible`, `gridSnap`, `ortho`, `polar`, `osnap`, `dynamicInput`, `lineweightDisplay`, `crosshairSize`, `symbolStandard`, `units`, `unitSuffix`, `precision`, `snapSpacing`, `gridSpacing`, `polarIncrement`, `language`, `workspace`, `modelBackground`. |
| `set(key, value)` | Writable: the first eight above (booleans; `crosshairSize` 1-100). Applied and saved at once. |
| `get('plugin:<key>')` / `set('plugin:<key>', value)` | Your plugin's own settings (any JSON value), kept per plugin. |
| `keys()` | The readable keys. |

Anything else throws, so `jcad.settings` cannot change file lists, window layout or security
answers (code in the page can still reach `localStorage` directly; see [Capabilities](#capabilities)).

### `jcad.files`

| Member | Description |
| --- | --- |
| `readText(accept?)` | Lets the user pick a file; resolves `{ name, text }` or `null`. `accept` like `".csv,.txt"`. |
| `saveText(name, text, filterName?)` | Save dialog (desktop) or download (browser); resolves the saved path/name or `null`. |

### `jcad.geometry`

`distance(a, b)`, `angle(from, to)` (radians, CCW from +X), `polar(from, angle, distance)`,
`midpoint(a, b)`, `bounds(entitiesOrIds)`, `rad(degrees)`, `deg(radians)`.

## Entity objects

Every entity has `id`, `type`, `layer`, `color` (`"ByLayer"` or an AutoCAD colour number)
and optionally `linetype`, `lineWeight` (mm). By type:

| `type` | Fields |
| --- | --- |
| `line` | `a`, `b` |
| `circle` | `center`, `radius`, `filled?` |
| `arc` | `center`, `radius`, `startAngle`, `endAngle` (CCW) |
| `polyline` | `points`, `closed`, `bulges?`, `width?`, `filled?` |
| `text` | `position`, `text`, `height` (default 0.125), `rotation` (0), `align` (`left` / `center` / `right`) |
| `mtext` | `position`, `text`, `height`, `width`, `rotation` |
| `insert` | `block` (must exist), `position`, `rotation`, `scale`, `attributes` (`{ TAG1: "CR1", ... }`) |
| `ellipse` | `center`, `majorAxis`, `ratio`, `startParam`, `endParam` |
| `point` | `position` |
| `xline` / `ray` | `base`, `direction` |
| `dimension` | `kind` (`linear`, `aligned`, `radius`, `diameter`, `angular`), `p1`, `p2`, `linePoint`, `rotation`, `center?`, `text?`, `style` (defaults to the current dimension style) |

Input is checked: unknown types, missing fields, non-finite coordinates, functions and
unknown blocks are rejected with an error that names the problem.

## Examples

The folder `examples/plugins/` holds three complete plugins; copy a folder into
`<app data>/plugins/` (or pick its files with PLUGINLOAD in the browser).

- **hello** – adds `HELLO` (alias `HI`), which logs how many objects are selected. The
  minimal plugin: one `commands.register` call.
- **numbered-labels** – adds `NUMLABEL` (alias `NLABEL`): prompts for a prefix and a first
  number on the command line, then places text labels `M7`, `M8`, ... at picked points until
  Enter. Shows `ui.prompt`, `ui.pick.point`, `document.add` and per-plugin settings (the
  prefix and next number are remembered).
- **bom-summary** – adds `BOMSUMMARY` (alias `BOMSUM`): counts the components by `MFG` and
  `CAT`, shows a table in a dialog and offers **Save CSV...**. Shows
  `electrical.components`, `ui.openDialog` and `files.saveText`.

A script for SCRIPTRUN is the same kind of file without `plugin.json`, e.g.:

```js
// Put every TEXT on layer NOTES in one undo step.
const texts = jcad.document.entities({ type: 'text' });
jcad.document.transact(() => {
  for (const t of texts) jcad.document.replace({ ...t, layer: 'NOTES' });
});
jcad.ui.log(`${texts.length} text(s) moved to NOTES.`);
```

In the developer console the same object is `window.jcadApi`
(`jcadApi.document.entities().length`); the installed application has no developer tools, so
this is for the browser edition and development builds (`npm run electron:dev`).
