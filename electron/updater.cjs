/**
 * Application updates from GitHub Releases.
 *
 * Two paths:
 *  - Windows NSIS installations with a configured trusted publisher update through
 *    electron-updater, which verifies the downloaded installer's signature.
 *  - Unsigned Windows, Linux, macOS, development runs and other installations
 *    only check: the GitHub Releases API is asked for the latest version and, if it
 *    is newer, the user is offered the download page. (macOS in-place updates need a
 *    Developer ID signed app; the ad-hoc signed builds cannot be swapped by Squirrel.)
 *    On macOS the release's latest-mac.yml names the macOS version it needs
 *    (minimumSystemVersion, from package.json build.mac.minimumSystemVersion): a Mac with
 *    an older system is not offered a download it could not run.
 *
 * Authenticity (security review E-8): besides electron-updater's own checks, the downloaded
 * installer is verified again right after the download and just before it is installed
 * (electron/update-verify.cjs): its SHA-512 against the release metadata and, on Windows when the
 * installation names a publisher, its signature. A failure installs nothing.
 */
const { app, dialog, shell, net } = require('electron');
const { parseVersion, compareVersions, minimumSystemVersionFrom, systemOlderThan } = require('./version.cjs');
const { externalUrl } = require('./ipc-guard.cjs');
const { installationHasTrustedPublisher } = require('./update-policy.cjs');
const { publisherNamesFrom, updateInfoProblem, verifyDownloadedUpdate } = require('./update-verify.cjs');

const OWNER = 'habit04';
const REPO = 'share';
const RELEASES_PAGE = `https://github.com/${OWNER}/${REPO}/releases`;
const LATEST_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
/** Delay before the silent check that runs after start-up. */
const STARTUP_DELAY_MS = 8000;

let autoUpdater = null;
let checking = false;
let downloaded = null; // version string once an update has been downloaded
/** @type {{ files: string[], info: any } | null} what downloadUpdate() gave for `downloaded` */
let downloadedUpdate = null;
/** @type {(status: { state: string, version?: string, percent?: number, message?: string, manual?: boolean }) => void} */
let statusSink = () => {};
/**
 * Asks the window whether it may close (unsaved-work prompt); set by main.
 * @type {(win: Electron.BrowserWindow) => Promise<boolean>}
 */
let confirmRestart = async () => true;
/** Acknowledged settings commit before final package verification and native installation. */
let beforeRestart = async (/** @type {Electron.BrowserWindow} */ _win) => true;

/** Whether electron-updater can replace this installation in place. */
function canSelfUpdate() {
  if (!app.isPackaged) return false;
  if (process.platform === 'win32') return !process.env.PORTABLE_EXECUTABLE_DIR && installationHasTrustedPublisher(process.resourcesPath);
  // Until release metadata has an independently trusted signature, Linux uses manual downloads.
  if (process.platform === 'linux') return false;
  return false; // macOS: ad-hoc signed builds cannot be swapped by Squirrel.Mac
}

function getAutoUpdater() {
  if (autoUpdater) return autoUpdater;
  // Required lazily so a missing module (browser dev runs) cannot break start-up.
  const mod = require('electron-updater');
  autoUpdater = mod.autoUpdater;
  autoUpdater.autoDownload = false;
  // Ordinary quit does not run our final checksum/publisher recheck or close workflow.
  autoUpdater.autoInstallOnAppQuit = false;
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

/** Only links into this project's GitHub repository are ever opened (parsed and compared, electron/ipc-guard.cjs externalUrl). */
function safeUrl(u) {
  return externalUrl(u, { cashApp: false }) ?? RELEASES_PAGE;
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

/** Is `u` a file of this project's GitHub releases (https://github.com/<owner>/<repo>/releases/download/...)? */
function isReleaseDownload(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === 'https:' && url.host === 'github.com' && !url.username && !url.password && url.pathname.startsWith(`/${OWNER}/${REPO}/releases/download/`);
  } catch {
    return false;
  }
}

/**
 * The macOS version `release` needs: minimumSystemVersion of its latest-mac.yml, or null when the
 * release has none (0.4.1 and earlier ran on macOS 11) or it cannot be read (then the download is
 * offered as before).
 */
async function releaseMinimumMacOS(release) {
  const meta = release.assets.find((a) => a.name === 'latest-mac.yml');
  if (!meta || !isReleaseDownload(meta.url)) return null;
  try {
    const res = await net.fetch(meta.url, { headers: { 'User-Agent': `JCad-Electrical/${app.getVersion()}` } });
    if (!res.ok) return null;
    return minimumSystemVersionFrom((await res.text()).slice(0, 64 * 1024));
  } catch {
    return null;
  }
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
  // A release that needs a newer macOS than this Mac has is not offered: its disk image would
  // install an application that does not start (0.4.2 needs macOS 13; 0.4.1 ran on macOS 11).
  if (process.platform === 'darwin') {
    const minimum = await releaseMinimumMacOS(release);
    const system = typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '';
    if (minimum && systemOlderThan(system, minimum)) {
      const message = `JCad Electrical ${release.version} needs macOS ${minimum} or later; this Mac runs macOS ${system}, so ${current} stays the version for it.`;
      statusSink({ state: 'unsupported', version: release.version, message });
      if (interactive) {
        const r = await dialog.showMessageBox(win, {
          type: 'info',
          title: 'Check for Updates',
          message: `JCad Electrical ${release.version} needs macOS ${minimum} or later.`,
          detail: `This Mac runs macOS ${system}. Keep using JCad Electrical ${current}: it stays available on the releases page. Updating macOS to ${minimum} or later makes the new version available.`,
          buttons: ['Release Notes', 'Close'],
          defaultId: 1,
          cancelId: 1,
        });
        if (r.response === 0) await shell.openExternal(safeUrl(release.url));
      }
      return { state: 'unsupported', version: release.version, message };
    }
  }
  statusSink({ state: 'available', version: release.version, manual: true });
  const r = await dialog.showMessageBox(win, {
    type: 'info',
    title: 'Update Available',
    message: `JCad Electrical ${release.version} is available (you have ${current}).`,
    detail:
      (process.platform === 'darwin'
        ? 'Download the new disk image and drag the app to Applications to replace this one. If macOS blocks the first launch, allow it once in System Settings > Privacy & Security.'
        : 'Download and install the new package over this one; your settings and drawings are kept.') + (release.notes ? `\n\n${release.notes.slice(0, 600)}` : ''),
    buttons: ['Download', 'Release Notes', 'Later'],
    defaultId: 0,
    cancelId: 2,
  });
  if (r.response === 0) await shell.openExternal(assetFor(release));
  else if (r.response === 1) await shell.openExternal(safeUrl(release.url));
  return { state: 'available', version: release.version };
}

/** Publisher names in the installation's app-update.yml (Windows; [] for an unsigned build). */
function installedPublisherNames() {
  if (process.platform !== 'win32') return [];
  try {
    return publisherNamesFrom(require('node:fs').readFileSync(require('node:path').join(process.resourcesPath, 'app-update.yml'), 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Verify the downloaded update (electron/update-verify.cjs). On failure nothing is installed:
 * the on-quit install is switched off and the download forgotten. Resolves the reason or null.
 */
async function verifyDownloaded() {
  const u = getAutoUpdater();
  u.autoInstallOnAppQuit = false;
  const d = downloadedUpdate;
  const why = d
    ? await verifyDownloadedUpdate({
        files: d.files,
        info: d.info,
        publisherNames: installedPublisherNames(),
        verifySignature: typeof u.verifyUpdateCodeSignature === 'function' ? (names, file) => u.verifyUpdateCodeSignature(names, file) : null,
      })
    : 'no downloaded update';
  if (why) {
    u.autoInstallOnAppQuit = false;
    downloaded = null;
    downloadedUpdate = null;
  }
  return why;
}

/** Offer to restart into the downloaded update; the unsaved-work prompt runs first. */
async function offerRestart(win, version) {
  const r = await dialog.showMessageBox(win, {
    type: 'info',
    title: 'Update Ready',
    message: `JCad Electrical ${version} has been downloaded.`,
    detail: 'Restart now to install it, or choose Check for Updates when you are ready. Quitting normally does not install it.',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (r.response !== 0) return;
  if (!(await confirmRestart(win))) return;
  // Verify after unsaved work, and once more after asynchronous settings/disk preparation.
  // A slow checkpoint must not leave an old package verification authorizing installation.
  let why = await verifyDownloaded();
  if (!why) {
    if (!(await beforeRestart(win))) return;
    why = await verifyDownloaded();
  }
  if (why) {
    statusSink({ state: 'error', message: `The update was not installed: ${why}.` });
    await dialog.showMessageBox(win, { type: 'warning', title: 'Update Not Installed', message: 'The downloaded update failed verification and was not installed.', detail: `${why}.\n\nYou can download the new version from the releases page.` });
    return;
  }
  getAutoUpdater().quitAndInstall(false, true);
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
  // Every file of the release metadata must carry a SHA-512 (E-8); otherwise the plain check
  // (download page) is offered instead.
  const metaProblem = updateInfoProblem(info);
  if (metaProblem) throw new Error(`The update cannot be verified: ${metaProblem}.`);
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
  /** @type {string[]} */
  let files;
  try {
    files = await u.downloadUpdate();
  } catch (err) {
    // The user asked for this download: always tell them it failed.
    const e = /** @type {Error & { userEngaged?: boolean }} */ (err instanceof Error ? err : new Error(String(err)));
    e.userEngaged = true;
    throw e;
  }
  downloadedUpdate = { files: Array.isArray(files) ? files : [], info };
  downloaded = info.version;
  // Verified right after the download too, so the on-quit install never runs an unverified file.
  const why = await verifyDownloaded();
  if (why) {
    const e = /** @type {Error & { userEngaged?: boolean }} */ (new Error(`The downloaded update failed verification and will not be installed: ${why}.`));
    e.userEngaged = true;
    throw e;
  }
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
  /** A final acknowledged settings checkpoint; false keeps the application open. */
  onBeforeRestart(fn) {
    beforeRestart = typeof fn === 'function' ? fn : async () => true;
  },
  /** The check "Restart Now" runs before quitAndInstall (main's Save All workflow); end-to-end tests drive it. */
  confirmRestart: (win) => confirmRestart(win),
};
