#!/usr/bin/env node
/**
 * Download alerts.
 *
 * GitHub has no event or webhook for "someone downloaded a release asset"; the only signal is
 * the `download_count` on each asset. This script polls those counters for every release and,
 * when an installer has been downloaded since the previous run, posts a comment on the
 * "Download tracker" issue. GitHub turns that comment into a notification (and an e-mail,
 * depending on the subscriber's notification settings) for everyone subscribed to the issue,
 * which is how the repository owner gets alerted.
 *
 * The last-seen counts live in the tracker issue's body (inside an HTML comment), so no extra
 * storage, secrets or external service are needed. Updater metadata (`latest*.yml`) and
 * `.blockmap` files are ignored because the auto-updater fetches them on every launch.
 *
 * Close the tracker issue to pause alerts; reopen it to resume (everything downloaded while it
 * was closed is reported in one comment on the next run).
 *
 * Run by .github/workflows/download-alerts.yml (hourly schedule + manual). Local use:
 *   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/download-alerts.mjs [--dry-run]
 * Without GITHUB_TOKEN the requests go through the `gh api` CLI instead.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

export const TRACKER_TITLE = 'Download tracker';
export const TRACKER_LABEL = 'download-tracker';
const STATE_RE = /<!--\s*download-state\s*([\s\S]*?)-->/;

/** Installers only: updater metadata and block maps are fetched by the app itself. */
export function isInstaller(name) {
  return !/\.(ya?ml|blockmap|sha256|sha512|sig|txt|json)$/i.test(name);
}

/**
 * Flatten the GitHub "list releases" payload into a map keyed by `<tag>/<asset name>`.
 * Draft releases are skipped (nobody can download from them).
 */
export function snapshotFromReleases(releases) {
  const assets = {};
  for (const rel of releases) {
    if (!rel || rel.draft) continue;
    const tag = rel.tag_name || rel.name || '?';
    for (const asset of rel.assets || []) {
      if (!asset || typeof asset.name !== 'string' || !isInstaller(asset.name)) continue;
      assets[`${tag}/${asset.name}`] = {
        tag,
        name: asset.name,
        count: Number(asset.download_count) || 0,
        url: asset.browser_download_url || '',
      };
    }
  }
  return assets;
}

/** `{ key: count }` view of a snapshot, which is what gets stored in the issue body. */
export function countsOf(snapshot) {
  const counts = {};
  for (const key of Object.keys(snapshot).sort()) counts[key] = snapshot[key].count;
  return counts;
}

/** Assets whose counter went up since `prev`; a key missing from `prev` counts from zero. */
export function diffCounts(prevCounts, snapshot) {
  const changes = [];
  for (const key of Object.keys(snapshot)) {
    const before = Number(prevCounts?.[key]) || 0;
    const after = snapshot[key].count;
    if (after > before) changes.push({ key, tag: snapshot[key].tag, name: snapshot[key].name, before, after, delta: after - before });
  }
  return changes.sort((a, b) => compareTags(b.tag, a.tag) || a.name.localeCompare(b.name));
}

export function totalOf(snapshot) {
  return Object.values(snapshot).reduce((sum, a) => sum + a.count, 0);
}

/** Read the hidden state block out of the tracker issue body; null when absent or damaged. */
export function parseState(body) {
  const m = STATE_RE.exec(body || '');
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.counts !== 'object' || parsed.counts === null) return null;
    return { counts: parsed.counts, updated: typeof parsed.updated === 'string' ? parsed.updated : null };
  } catch {
    return null;
  }
}

/** Issue body: a short explanation, a per-release table and the hidden state block. */
export function renderBody(snapshot, updatedIso) {
  const byTag = groupByTag(snapshot);
  const lines = [
    'This issue is maintained by the **Download alerts** workflow (`.github/workflows/download-alerts.yml`).',
    'Each time an installer from a GitHub Release is downloaded, the workflow comments here, and GitHub',
    'notifies everyone subscribed to this issue. Close the issue to pause the alerts; reopen it to resume.',
    '',
    `All-time installer downloads: **${totalOf(snapshot)}** (counted ${updatedIso}).`,
    '',
    '| Release | Installer | Downloads |',
    '|---|---|---:|',
  ];
  for (const tag of Object.keys(byTag).sort((a, b) => compareTags(b, a))) {
    for (const asset of byTag[tag]) lines.push(`| ${tag} | ${asset.name} | ${asset.count} |`);
  }
  lines.push('', '<!-- download-state', JSON.stringify({ updated: updatedIso, counts: countsOf(snapshot) }, null, 1), '-->', '');
  return lines.join('\n');
}

/** Comment posted when counters went up. */
export function renderComment(changes, snapshot, sinceIso, nowIso) {
  const total = changes.reduce((sum, c) => sum + c.delta, 0);
  const lines = [
    `**${total} new download${total === 1 ? '' : 's'}** ${sinceIso ? `since ${sinceIso}` : 'since the last check'} (checked ${nowIso}):`,
    '',
  ];
  for (const c of changes) {
    const link = snapshot[c.key]?.url ? `[${c.name}](${snapshot[c.key].url})` : c.name;
    lines.push(`- ${c.tag} · ${link}: +${c.delta} (now ${c.after})`);
  }
  lines.push('', `All-time installer downloads: ${totalOf(snapshot)}.`);
  return lines.join('\n');
}

function groupByTag(snapshot) {
  const byTag = {};
  for (const asset of Object.values(snapshot)) (byTag[asset.tag] ||= []).push(asset);
  for (const list of Object.values(byTag)) list.sort((a, b) => a.name.localeCompare(b.name));
  return byTag;
}

/** Newest tag first when sorted descending: numeric comparison of dotted versions, text otherwise. */
export function compareTags(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map(Number);
  const pb = String(b).replace(/^v/i, '').split('.').map(Number);
  if (pa.every(Number.isFinite) && pb.every(Number.isFinite)) {
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d) return d;
    }
    return 0;
  }
  return String(a).localeCompare(String(b));
}

// ---------------------------------------------------------------------------------------------
// GitHub API access (fetch with GITHUB_TOKEN, or the `gh api` CLI when no token is in the env).

function makeApi(repo, token) {
  const base = 'https://api.github.com';
  return async function api(method, path, body) {
    if (token) {
      const res = await fetch(base + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'jcad-download-alerts',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      if (!res.ok) {
        const err = /** @type {Error & { status?: number }} */ (new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`));
        err.status = res.status;
        throw err;
      }
      return text ? JSON.parse(text) : null;
    }
    const args = ['api', '-X', method, path];
    if (body) args.push('--input', '-');
    try {
      const out = execFileSync('gh', args, { input: body ? JSON.stringify(body) : undefined, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      return out.trim() ? JSON.parse(out) : null;
    } catch (e) {
      const err = /** @type {Error & { status?: number }} */ (new Error(`${method} ${path} failed: ${(e.stderr || e.message || '').toString().slice(0, 300)}`));
      err.status = /HTTP (\d{3})/.exec(String(e.stderr || ''))?.[1] ? Number(/HTTP (\d{3})/.exec(String(e.stderr))[1]) : undefined;
      throw err;
    }
  };
}

async function listAll(api, path) {
  const all = [];
  for (let page = 1; page < 20; page++) {
    const batch = await api('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

async function findTracker(api, repo) {
  const issues = await api('GET', `/repos/${repo}/issues?labels=${encodeURIComponent(TRACKER_LABEL)}&state=all&sort=created&direction=asc&per_page=10`);
  return (issues || []).find((i) => !i.pull_request) || null;
}

async function ensureLabel(api, repo) {
  try {
    await api('POST', `/repos/${repo}/labels`, {
      name: TRACKER_LABEL,
      color: '0e8a16',
      description: 'Maintained by the Download alerts workflow',
    });
  } catch (e) {
    if (e.status !== 422) throw e; // 422 = already exists
  }
}

function summary(line) {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + '\n');
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo || !repo.includes('/')) throw new Error('GITHUB_REPOSITORY must be owner/repo');
  const dryRun = argv.includes('--dry-run');
  const api = makeApi(repo, env.GITHUB_TOKEN);
  const now = new Date().toISOString();

  const releases = await listAll(api, `/repos/${repo}/releases`);
  const snapshot = snapshotFromReleases(releases);
  const assetCount = Object.keys(snapshot).length;
  console.log(`${releases.length} release(s), ${assetCount} installer asset(s), ${totalOf(snapshot)} download(s) in total.`);

  const issue = await findTracker(api, repo);
  if (!issue) {
    const body = renderBody(snapshot, now);
    if (dryRun) {
      summary(`[dry-run] Would create the "${TRACKER_TITLE}" issue with the current counts as the baseline.`);
      console.log(body);
      return { action: 'create', changes: [] };
    }
    await ensureLabel(api, repo);
    const created = await api('POST', `/repos/${repo}/issues`, { title: TRACKER_TITLE, body, labels: [TRACKER_LABEL] });
    summary(`Created tracker issue #${created.number} (${created.html_url}); current counts recorded as the baseline, no alert for past downloads.`);
    return { action: 'create', changes: [], issue: created.number };
  }

  if (issue.state !== 'open') {
    summary(`Tracker issue #${issue.number} is closed: alerts paused. Reopen it to resume.`);
    return { action: 'paused', changes: [], issue: issue.number };
  }

  const state = parseState(issue.body);
  if (!state) {
    const body = renderBody(snapshot, now);
    if (dryRun) {
      summary(`[dry-run] Tracker issue #${issue.number} has no readable state; would rewrite its body with the current counts.`);
      return { action: 'reset', changes: [], issue: issue.number };
    }
    await api('PATCH', `/repos/${repo}/issues/${issue.number}`, { body });
    summary(`Tracker issue #${issue.number} had no readable state; rewrote it with the current counts as the new baseline.`);
    return { action: 'reset', changes: [], issue: issue.number };
  }

  const changes = diffCounts(state.counts, snapshot);
  if (changes.length === 0) {
    summary(`No new downloads since ${state.updated || 'the last check'}.`);
    return { action: 'none', changes, issue: issue.number };
  }

  const comment = renderComment(changes, snapshot, state.updated, now);
  const body = renderBody(snapshot, now);
  if (dryRun) {
    summary(`[dry-run] Would comment on tracker issue #${issue.number}:`);
    console.log(comment);
    return { action: 'alert', changes, issue: issue.number };
  }
  const posted = await api('POST', `/repos/${repo}/issues/${issue.number}/comments`, { body: comment });
  await api('PATCH', `/repos/${repo}/issues/${issue.number}`, { body });
  summary(`Posted download alert on tracker issue #${issue.number}: ${posted.html_url}`);
  return { action: 'alert', changes, issue: issue.number };
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
