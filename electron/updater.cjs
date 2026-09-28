/**
 * Application updates from GitHub Releases.
 *
 * Two paths:
 *  - Windows (NSIS installer) and Linux AppImage builds update in place through
 *    electron-updater: the release carries latest.yml / latest-linux.yml written by
 *    electron-builder, the new installer is downloaded and applied on restart.
 *  - macOS, Linux .deb, development runs and anything electron-updater cannot handle
 *    only check: the GitHub Releases API is asked for the latest version and, if it
 *    is newer, the user is offered the download page. (macOS in-place updates need a
 *    Developer ID signed app; the ad-hoc signed builds cannot be swapped by Squirrel.)
 */
const { app, dialog, shell, net } = require('electron');
const { parseVersion, compareVersions } = require('./version.cjs');

const OWNER = 'habit04';
const REPO = 'share';
const RELEASES_PAGE = `https://github.com/${OWNER}/${REPO}/releases`;
const LATEST_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
/** Delay before the silent check that runs after start-up. */
const STARTUP_DELAY_MS = 8000;

let autoUpdater = null;
let checking = false;
let downloaded = null; // version string once an update has been downloaded
let statusSink = () => {};
/** Asks the window whether it may close (unsaved-work prompt); set by main. */
let confirmRestart = async () => true;

/** Whether electron-updater can replace this installation in place. */
function canSelfUpdate() {
  if (!app.isPackaged) return false;
  if (process.platform === 'win32') return !process.env.PORTABLE_EXECUTABLE_DIR;
  if (process.platform === 'linux') return Boolean(process.env.APPIMAGE);
  return false; // macOS: ad-hoc signed builds cannot be swapped by Squirrel.Mac
}

function getAutoUpdater() {
  if (autoUpdater) return autoUpdater;
  // Required lazily so a missing module (browser dev runs) cannot break start-up.
  const mod = require('electron-updater');
  autoUpdater = mod.autoUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;
  autoUpdater.on('download-progress', (p) => statusSink({ state: 'downloading', percent: Math.round(p.percent || 0) }));
  return autoUpdater;
}

/** Ask the GitHub API for the newest non-prerelease release. */
async function fetchLatestRelease() {
  const res = await net.fetch(LATEST_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `JCad-Electrical/${app.getVersion()}` } });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const json = await res.json();
  const version = String(json.tag_name || '').replace(/^v/, '');
  if (!parseVersion(version)) throw new Error('Release has no version tag');
  const assets = Array.isArray(json.assets) ? json.assets.map((a) => ({ name: String(a.name || ''), url: String(a.browser_download_url || '') })) : [];
  return { version, url: String(json.html_url || RELEASES_PAGE), notes: String(json.body || ''), assets };
}

/** Only links into this project's GitHub repository are ever opened. */
function safeUrl(u) {
  return /^https:\/\/github\.com\/habit04\/share\//.test(String(u || '')) ? String(u) : RELEASES_PAGE;
}

/** The download that fits this machine, or the release page. */
function assetFor(release) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const want =
    process.platform === 'darwin' ? (a) => /\.dmg$/i.test(a.name) && a.name.includes(arch)
    : process.platform === 'win32' ? (a) => /\.exe$/i.test(a.name)
    : process.env.APPIMAGE ? (a) => /\.AppImage$/i.test(a.name)
    : (a) => /\.deb$/i.test(a.name);
  const hit = release.assets.find(want);
  return safeUrl(hit ? hit.url : release.url);
}

async function checkViaApi(win, interactive) {
  const current = app.getVersion();
  const release = await fetchLatestRelease();
  if (compareVersions(release.version, current) <= 0) {
    statusSink({ state: 'up-to-date', version: current });
    if (interactive) {
      await dialog.showMessageBox(win, { type: 'info', title: 'Check for Updates', message: `JCad Electrical ${current} is up to date.`, detail: `Latest release: ${release.version}.` });
    }
    return { state: 'up-to-date', version: current };
  }
  statusSink({ state: 'available', version: release.version, manual: true });
  const r = await dialog.showMessageBox(win, {
    type: 'info',
    title: 'Update Available',
    message: `JCad Electrical ${release.version} is available (you have ${current}).`,
    detail:
      (process.platform === 'darwin'
        ? 'Download the new disk image, drag the app to Applications to replace this one, then open it once through System Settings > Privacy & Security > Open Anyway.'
        : 'Download and install the new package over this one; your settings and drawings are kept.') + (release.notes ? `\n\n${release.notes.slice(0, 600)}` : ''),
    buttons: ['Download', 'Release Notes', 'Later'],
    defaultId: 0,
    cancelId: 2,
  });
  if (r.response === 0) await shell.openExternal(assetFor(release));
  else if (r.response === 1) await shell.openExternal(safeUrl(release.url));
  return { state: 'available', version: release.version };
}

/** Offer to restart into the downloaded update; the unsaved-work prompt runs first. */
async function offerRestart(win, version) {
  const r = await dialog.showMessageBox(win, {
    type: 'info',
    title: 'Update Ready',
    message: `JCad Electrical ${version} has been downloaded.`,
    detail: 'Restart now to install it, or it will be installed when you quit.',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (r.response !== 0) return;
  if (await confirmRestart(win)) getAutoUpdater().quitAndInstall(false, true);
}

async function checkViaUpdater(win, interactive) {
  const u = getAutoUpdater();
  const current = app.getVersion();
  if (downloaded) {
    await offerRestart(win, downloaded);
    return { state: 'downloaded', version: downloaded };
  }
  const result = await u.checkForUpdates();
  const info = result && result.updateInfo;
  if (!info || compareVersions(info.version, current) <= 0) {
    statusSink({ state: 'up-to-date', version: current });
    if (interactive) await dialog.showMessageBox(win, { type: 'info', title: 'Check for Updates', message: `JCad Electrical ${current} is up to date.` });
    return { state: 'up-to-date', version: current };
  }
  statusSink({ state: 'available', version: info.version });
  const notes = typeof info.releaseNotes === 'string' ? info.releaseNotes.replace(/<[^>]+>/g, '').trim() : '';
  const r = await dialog.showMessageBox(win, {
    type: 'info',
    title: 'Update Available',
    message: `JCad Electrical ${info.version} is available (you have ${current}).`,
    detail: `Download it now? The update installs when you restart the application.${notes ? `\n\n${notes.slice(0, 600)}` : ''}`,
    buttons: ['Download', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (r.response !== 0) return { state: 'available', version: info.version };
  statusSink({ state: 'downloading', percent: 0 });
  try {
    await u.downloadUpdate();
  } catch (err) {
    // The user asked for this download: always tell them it failed.
    const e = err instanceof Error ? err : new Error(String(err));
    e.userEngaged = true;
    throw e;
  }
  downloaded = info.version;
  statusSink({ state: 'downloaded', version: info.version });
  await offerRestart(win, info.version);
  return { state: 'downloaded', version: info.version };
}

/**
 * Check for a newer release. `interactive` (menu / command) reports "up to date"
 * and errors; the silent start-up check only speaks when an update exists.
 */
async function checkForUpdates(win, { interactive = true } = {}) {
  if (checking) return { state: 'busy' };
  checking = true;
  statusSink({ state: 'checking' });
  try {
    if (canSelfUpdate()) {
      try {
        return await checkViaUpdater(win, interactive);
      } catch (err) {
        // Missing update metadata on the release, ...: fall back to the plain check (but never
        // after the user already clicked Download - that failure is reported below).
        if (interactive && !(err && err.userEngaged)) return await checkViaApi(win, interactive);
        throw err;
      }
    }
    return await checkViaApi(win, interactive);
  } catch (err) {
    statusSink({ state: 'error', message: String((err && err.message) || err) });
    if (interactive || (err && err.userEngaged)) {
      const r = await dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Check for Updates',
        message: 'Could not check for updates.',
        detail: `${String((err && err.message) || err)}\n\nYou can look for new versions on the releases page.`,
        buttons: ['Open Releases Page', 'Close'],
        defaultId: 0,
        cancelId: 1,
      });
      if (r.response === 0) await shell.openExternal(RELEASES_PAGE);
    }
    return { state: 'error', message: String((err && err.message) || err) };
  } finally {
    checking = false;
  }
}

/** Run the silent check once the window is up (skipped in development). */
function scheduleStartupCheck(getWindow, enabled = () => true) {
  if (!app.isPackaged) return;
  setTimeout(() => {
    const win = getWindow();
    if (!win || win.isDestroyed() || !enabled()) return;
    checkForUpdates(win, { interactive: false }).catch(() => {});
  }, STARTUP_DELAY_MS);
}

module.exports = {
  checkForUpdates,
  scheduleStartupCheck,
  compareVersions,
  parseVersion,
  canSelfUpdate,
  RELEASES_PAGE,
  onStatus(fn) {
    statusSink = typeof fn === 'function' ? fn : () => {};
  },
  /** fn(win) -> Promise<boolean>: may the application close now (unsaved work handled)? */
  onConfirmRestart(fn) {
    confirmRestart = typeof fn === 'function' ? fn : async () => true;
  },
};
