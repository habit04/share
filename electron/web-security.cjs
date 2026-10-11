/**
 * Browser-side defences of the main process (security review E-12): no web permission is granted
 * except writing to the clipboard from the application page, and no web contents - the main
 * window, the hidden plot / print windows, anything created later - may open windows, navigate
 * away or attach a <webview>.
 *
 * The application needs no camera, microphone, location, notifications, MIDI, HID, serial, USB,
 * clipboard reading or other browser permission; a compromised renderer could otherwise ask for
 * them and Electron's default (no handler) grants most requests. The one exception is
 * `clipboard-sanitized-write` for the application page (navigator.clipboard.writeText: Copy Full
 * File Path, the import report and the problem report copy buttons).
 *
 * Ported from PR #2 (codex/electrical-review-fixes 2f89b0e, electron/main.cjs secureContents and
 * the session handlers), moved into this module and extended to every web contents created
 * (`web-contents-created`) and to <webview> attachment.
 */
'use strict';

/** The permissions the application page may use. */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);

/**
 * May `contents` use `permission`? Only the application window's own page, only the allowed ones.
 * @param {unknown} contents  the requesting web contents (null for some checks)
 * @param {string} permission
 * @param {unknown} appContents  the main window's web contents (or null)
 */
function permissionAllowed(contents, permission, appContents) {
  return !!contents && contents === appContents && ALLOWED_PERMISSIONS.has(permission);
}

/**
 * Deny every permission request and check except ALLOWED_PERMISSIONS for the application page.
 * @param {Pick<Electron.Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>} session
 * @param {() => unknown} appContents  the main window's web contents, when there is one
 */
function installPermissionHandlers(session, appContents) {
  session.setPermissionRequestHandler((contents, permission, callback) => callback(permissionAllowed(contents, permission, appContents())));
  session.setPermissionCheckHandler((contents, permission) => permissionAllowed(contents, permission, appContents()));
}

/**
 * No new windows, no navigation away from the loaded page, no <webview>.
 * @param {Pick<Electron.WebContents, 'setWindowOpenHandler' | 'on'>} contents
 */
function secureContents(contents) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (/** @type {Electron.Event} */ e) => e.preventDefault());
  contents.on('will-attach-webview', (/** @type {Electron.Event} */ e) => e.preventDefault());
}

/**
 * secureContents for every web contents the application creates, from now on.
 * @param {Pick<Electron.App, 'on'>} app
 */
function installWebContentsGuards(app) {
  app.on('web-contents-created', (_e, contents) => secureContents(contents));
}

module.exports = { ALLOWED_PERMISSIONS, permissionAllowed, installPermissionHandlers, secureContents, installWebContentsGuards };
