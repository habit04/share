// Build the public website into site-dist/: the landing page from site/ (with the author,
// donation and project values from src/app/about.json injected) plus the browser edition of
// the application (Vite, mode "site") in site-dist/app/. Deployed by .github/workflows/pages.yml.
//
//   node scripts/build-site.mjs            full build
//   node scripts/build-site.mjs --no-app   landing page only (keeps an existing site-dist/app)
import { cp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'site-dist');
const withApp = !process.argv.includes('--no-app');

const about = JSON.parse(await readFile(join(root, 'src/app/about.json'), 'utf8'));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Same rules as src/app/about.ts: https links to github.com / cash.app only. */
function safeUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    if (!['github.com', 'cash.app'].some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) return null;
    return u.toString();
  } catch {
    return null;
  }
}
const cashtag = String(about.donate?.cashtag ?? '').trim().replace(/^\$/, '');
const donateUrl = /^[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(cashtag) ? `https://cash.app/$${cashtag}` : '';
const links = (about.author?.links ?? [])
  .filter((l) => l.label && safeUrl(l.url))
  .map((l) => `<a href="${esc(safeUrl(l.url))}" rel="noopener">${esc(l.label)}</a>`)
  .join('\n            ');

const values = {
  'author.name': esc(about.author.name),
  'author.title': esc(about.author.title),
  'author.bio': esc(about.author.bio),
  'author.location': esc(about.author.location),
  'author.links': links,
  'donate.url': esc(donateUrl),
  'donate.cashtag': esc(donateUrl ? `$${cashtag}` : ''),
  'donate.message': esc(about.donate?.message ?? ''),
  'project.homepage': esc(safeUrl(about.project.homepage) ?? 'https://github.com/habit04/share'),
  'project.issues': esc(safeUrl(about.project.issues) ?? 'https://github.com/habit04/share/issues'),
  'project.releases': esc(safeUrl(about.project.releases) ?? 'https://github.com/habit04/share/releases'),
  'project.license': esc(about.project.license),
  version: esc(pkg.version),
  year: String(new Date().getFullYear()),
};

function render(html) {
  html = html.replace(/<!-- if donate -->([\s\S]*?)<!-- endif donate -->/g, donateUrl ? '$1' : '');
  const missing = new Set();
  html = html.replace(/\{\{([a-z.]+)\}\}/g, (m, key) => {
    if (key in values) return values[key];
    missing.add(key);
    return m;
  });
  if (missing.size) throw new Error(`site/index.html uses unknown placeholders: ${[...missing].join(', ')}`);
  return html;
}

// 1. Landing page.
if (withApp) await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(join(root, 'site'), out, { recursive: true });
await writeFile(join(out, 'index.html'), render(await readFile(join(root, 'site/index.html'), 'utf8')));
await writeFile(join(out, '.nojekyll'), '');

// 2. Browser edition (vite build --mode site -> site-dist/app, base ./; see vite.config.ts).
if (withApp) {
  execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--mode', 'site'], { cwd: root, stdio: 'inherit' });
}

for (const f of ['index.html', 'site.css', 'site.js', 'app/index.html']) {
  await stat(join(out, f)).catch(() => {
    throw new Error(`build-site: ${f} was not produced`);
  });
}
console.log(`site-dist/ ready: landing page (author ${about.author.name}, donate ${donateUrl || 'hidden'}) + browser edition in site-dist/app/`);
