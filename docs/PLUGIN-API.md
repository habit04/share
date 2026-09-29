# Plugin and scripting API

JCad Electrical can be extended with JavaScript: **plugins** add commands and react to
events, **scripts** (SCRIPTRUN) are one-off programs run against the open drawing, and the
same API is available in the developer console as `window.jcadApi`.

- API version: **1** (`jcad.apiVersion`). Additions keep the version; an incompatible
  change bumps it, and a plugin that declares a newer `apiVersion` than the app provides is
  refused with a message instead of half-working.
- Everything the API hands out is a **frozen copy**. To change the drawing you pass entities
  back through `document.add / replace / remove` or group changes with `document.transact`;
  every change is an undo step like any command (Ctrl+Z works).
- Errors thrown by plugin code (while loading, in a command, in an event listener, in a
  rejected promise) are caught and printed on the command line as `[plugin-name] ...`. A
  plugin cannot crash the editor.

Contents: [Quick start](#quick-start) · [Packaging](#packaging-a-plugin) ·
[Lifecycle](#lifecycle) · [Commands](#commands) · [Security](#security) ·
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
   If it returns a promise, loading waits for it. If it throws (or the promise rejects),
   everything the plugin registered so far is removed and PLUGINS shows the error.
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

Plugins run inside the application window with the same rights as the application's own
code: they can read and change every open drawing, save files through the save dialog and
show dialogs. They **cannot** use Node.js, read arbitrary files (only files the user picks
with `files.readText`) or reach other web sites (the window's Content-Security-Policy
allows connections to the application only).

Before a plugin (or script) runs the first time the user is asked:

> Load plugin *name* from *path*? Plugins run with full access to your drawings.

The answer is remembered in the renderer's `localStorage` under **`jcad.plugins.trusted`**:
a JSON object keyed by `"<origin>:<path>"` (`folder:`, `file:` or `script:`) holding
`{ answer: "yes" | "no", hash, at }`, where `hash` is the SHA-256 of the code. When the code
changes the user is asked again. A "no" is kept at start-up (the plugin is listed as
*declined*); `PLUGINLOAD <folder>` asks again. `PLUGINS Forget` clears answers.

Plugin settings written with `jcad.settings.set('plugin:<key>', value)` live in
`localStorage` under `jcad.plugins.settings.<plugin name>`.

How the code is run: the renderer calls `new Function('jcad', code)`. The desktop window's
Content-Security-Policy does not allow that (no `'unsafe-eval'`), so there the code is
handed to the preload bridge (`pluginsEval`, Electron `webFrame.executeJavaScript`) and runs
in the page with the same single `jcad` argument. The main process only lists and reads
plugin folders (`plugins-list`, `plugins-read`, `plugins-dir`); names are checked so a plugin
cannot point outside its own folder.

Only install plugins from people you trust, as you would any program.

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

Anything else throws, so a plugin cannot change file lists, window layout or security answers.

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
(`jcadApi.document.entities().length`).
