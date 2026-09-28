// JCad Electrical website: fills the download buttons from the latest GitHub release,
// highlights the visitor's platform and runs the screenshot lightbox. No dependencies.
(function () {
  'use strict';
  var REPO = 'habit04/share';
  var API = 'https://api.github.com/repos/' + REPO + '/releases/latest';
  var CACHE_KEY = 'jcad.latestRelease';
  var CACHE_MS = 30 * 60 * 1000;

  // Installer file names follow electron-builder's ${name}-${version}-${os}-${arch}.${ext}.
  var MATCHERS = {
    win: function (n) { return /\.exe$/i.test(n); },
    'mac-arm64': function (n) { return /\.dmg$/i.test(n) && /arm64|aarch64|apple/i.test(n); },
    'mac-x64': function (n) { return /\.dmg$/i.test(n) && !/arm64|aarch64|apple/i.test(n); },
    'linux-appimage': function (n) { return /\.AppImage$/i.test(n); },
    'linux-deb': function (n) { return /\.deb$/i.test(n); },
  };

  function detectOs() {
    var ua = navigator.userAgent || '';
    var plat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    var s = (plat + ' ' + ua).toLowerCase();
    if (/iphone|ipad|android/.test(s)) return 'mobile';
    if (/win/.test(s)) return 'win';
    if (/mac/.test(s)) return 'mac';
    if (/linux|x11|cros/.test(s)) return 'linux';
    return '';
  }

  function assetFor(release, key) {
    var m = MATCHERS[key];
    if (!m || !release || !release.assets) return null;
    for (var i = 0; i < release.assets.length; i += 1) {
      if (m(release.assets[i].name || '')) return release.assets[i];
    }
    return null;
  }

  function fmtSize(bytes) {
    if (!bytes) return '';
    return (bytes / 1048576).toFixed(bytes > 100 * 1048576 ? 0 : 1) + ' MB';
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function readCache() {
    try {
      var raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var c = JSON.parse(raw);
      if (!c || Date.now() - c.at > CACHE_MS) return null;
      return c.release;
    } catch (e) {
      return null;
    }
  }

  function writeCache(release) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), release: release }));
    } catch (e) {
      /* private mode: ignore */
    }
  }

  function fetchLatest() {
    var cached = readCache();
    if (cached) return Promise.resolve(cached);
    if (typeof fetch !== 'function') return Promise.reject(new Error('no fetch'));
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, 8000) : 0;
    return fetch(API, { headers: { Accept: 'application/vnd.github+json' }, signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        if (!r.ok) throw new Error('GitHub API ' + r.status);
        return r.json();
      })
      .then(function (release) {
        if (!release || !release.tag_name) throw new Error('unexpected response');
        // Keep only what the page needs; the full response is ~20 KB.
        var slim = {
          tag_name: release.tag_name,
          html_url: release.html_url,
          published_at: release.published_at,
          assets: (release.assets || []).map(function (a) {
            return { name: a.name, browser_download_url: a.browser_download_url, size: a.size };
          }),
        };
        writeCache(slim);
        return slim;
      })
      .finally(function () { clearTimeout(timer); });
  }

  function setText(sel, text) {
    var els = document.querySelectorAll(sel);
    for (var i = 0; i < els.length; i += 1) els[i].textContent = text;
  }

  function applyRelease(release, os) {
    var version = release.tag_name.replace(/^v?/, 'v');
    setText('[data-version]', version);
    var date = document.getElementById('release-date');
    if (date) date.textContent = fmtDate(release.published_at);
    var note = document.getElementById('release-note');
    if (note) note.textContent = 'Latest release ' + version + (release.published_at ? ' (' + fmtDate(release.published_at) + ')' : '') + '.';

    var buttons = document.querySelectorAll('[data-asset]');
    for (var i = 0; i < buttons.length; i += 1) {
      var btn = buttons[i];
      var key = btn.getAttribute('data-asset');
      if (key === 'auto') key = os === 'win' ? 'win' : os === 'mac' ? 'mac-arm64' : os === 'linux' ? 'linux-appimage' : '';
      var asset = key ? assetFor(release, key) : null;
      if (asset) {
        btn.href = asset.browser_download_url;
        btn.setAttribute('download', '');
        var size = document.querySelector('[data-size="' + key + '"]');
        if (size) {
          size.textContent = fmtSize(asset.size);
          size.title = asset.name;
        }
      } else {
        btn.href = release.html_url || btn.href;
      }
    }
  }

  function applyOs(os) {
    var label = document.querySelector('#primary-download .dl-os');
    var names = { win: 'for Windows', mac: 'for macOS', linux: 'for Linux' };
    if (label && names[os]) label.textContent = names[os];
    if (os === 'mobile' && label) label.textContent = 'the desktop app';
    var cards = document.querySelectorAll('.dl-card[data-os]');
    for (var i = 0; i < cards.length; i += 1) {
      if (cards[i].getAttribute('data-os') === os) cards[i].classList.add('current');
    }
  }

  function showFallback() {
    var fb = document.getElementById('dl-fallback');
    if (fb) fb.hidden = false;
    var note = document.getElementById('release-note');
    if (note) note.textContent = 'Download the installer for your platform from the releases page.';
  }

  function initDownloads() {
    var os = detectOs();
    applyOs(os);
    fetchLatest().then(function (release) { applyRelease(release, os); }, showFallback);
  }

  function initLightbox() {
    var dlg = document.getElementById('lightbox');
    if (!dlg || typeof dlg.showModal !== 'function') return;
    var img = dlg.querySelector('img');
    var links = document.querySelectorAll('a[data-lightbox]');
    for (var i = 0; i < links.length; i += 1) {
      links[i].addEventListener('click', function (ev) {
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey) return; // let "open in new tab" work
        ev.preventDefault();
        var inner = this.querySelector('img');
        img.src = this.getAttribute('href');
        img.alt = inner ? inner.alt : '';
        dlg.showModal();
      });
    }
    dlg.querySelector('.lightbox-close').addEventListener('click', function () { dlg.close(); });
    dlg.addEventListener('click', function (ev) { if (ev.target === dlg) dlg.close(); });
    dlg.addEventListener('close', function () { img.removeAttribute('src'); });
  }

  initDownloads();
  initLightbox();
})();
