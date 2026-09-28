/**
 * Runtime diagnostics for problem reports: a ring buffer of errors seen by the
 * renderer (uncaught exceptions, unhandled promise rejections, console.error)
 * with timestamps, plus helpers that assemble a report from the editor state.
 */
export interface DiagnosticEntry {
  time: number;
  kind: 'error' | 'rejection' | 'console';
  message: string;
}

const MAX_ENTRIES = 60;
const entries: DiagnosticEntry[] = [];
let installed = false;

function push(kind: DiagnosticEntry['kind'], message: string): void {
  entries.push({ time: Date.now(), kind, message: message.slice(0, 2000) });
  if (entries.length > MAX_ENTRIES) entries.shift();
}

/** Start capturing errors. Safe to call more than once. */
export function installDiagnostics(target: Window = window): void {
  if (installed) return;
  installed = true;
  target.addEventListener('error', (ev) => {
    const e = ev.error as unknown;
    push('error', e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : ev.message || String(e));
  });
  target.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason as unknown;
    push('rejection', r instanceof Error ? `${r.message}\n${r.stack ?? ''}` : String(r));
  });
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    push('console', args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : typeof a === 'string' ? a : safeJson(a))).join(' '));
    original(...args);
  };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Captured errors, oldest first. */
export function diagnosticEntries(): readonly DiagnosticEntry[] {
  return entries;
}

/** Record something the application itself noticed (e.g. a failed file operation). */
export function recordDiagnostic(message: string): void {
  push('console', message);
}

export function clearDiagnostics(): void {
  entries.length = 0;
}

export interface ReportInput {
  title: string;
  happened: string;
  expected: string;
  steps: string;
  version: string;
  platform: string;
  arch: string;
  history: readonly string[];
  errors: readonly DiagnosticEntry[];
  drawingName?: string;
  extra?: readonly string[];
}

const iso = (t: number) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);

/** The diagnostics block (history + errors) shared by the issue body and the saved report. */
export function diagnosticsText(input: Pick<ReportInput, 'history' | 'errors' | 'extra'>, maxHistory = 40): string {
  const lines: string[] = [];
  if (input.extra && input.extra.length) lines.push(...input.extra, '');
  lines.push(`Command history (last ${Math.min(maxHistory, input.history.length)}):`);
  for (const h of input.history.slice(-maxHistory)) lines.push(`  ${h}`);
  lines.push('', `Captured errors (${input.errors.length}):`);
  if (input.errors.length === 0) lines.push('  none');
  for (const e of input.errors.slice(-15)) lines.push(`  [${iso(e.time)}] ${e.kind}: ${e.message.split('\n')[0]}`);
  return lines.join('\n');
}

/** Full plain-text report (for Copy / Save / e-mail). */
export function reportText(input: ReportInput): string {
  const body = [
    `JCad Electrical problem report`,
    `==============================`,
    `Title: ${input.title || '(none)'}`,
    `Version: ${input.version}  Platform: ${input.platform} ${input.arch}`,
    `Date: ${iso(Date.now())}`,
    input.drawingName ? `Drawing: ${input.drawingName}` : '',
    '',
    'What happened',
    '-------------',
    input.happened || '(not described)',
    '',
    'What was expected',
    '-----------------',
    input.expected || '(not described)',
    '',
    'Steps to reproduce',
    '------------------',
    input.steps || '(none)',
    '',
    'Diagnostics',
    '-----------',
    diagnosticsText(input, 80),
    '',
  ];
  for (const e of input.errors.slice(-5)) if (e.message.includes('\n')) body.push(`--- ${e.kind} @ ${iso(e.time)} ---`, e.message, '');
  return body.filter((l) => l !== undefined).join('\n');
}

const REPO_ISSUES = 'https://github.com/habit04/share/issues/new';
/** Browsers reject very long URLs; keep the prefilled body well under 8 KB. */
const MAX_URL_BODY = 6000;

/** URL that opens a prefilled GitHub bug-report form (the issue template's field ids are the query keys). */
export function issueUrl(input: ReportInput): string {
  const params = new URLSearchParams();
  params.set('template', 'bug_report.yml');
  params.set('title', `[Bug] ${input.title || input.happened.split('\n')[0]?.slice(0, 80) || 'Problem report'}`);
  params.set('what-happened', input.happened);
  params.set('expected', input.expected);
  if (input.steps) params.set('steps', input.steps);
  params.set('version', `${input.version}, ${input.platform} ${input.arch}`);
  let diag = diagnosticsText(input, 25);
  if (diag.length > MAX_URL_BODY) diag = diag.slice(0, MAX_URL_BODY) + '\n... (truncated; full report available with Save Report)';
  params.set('diagnostics', diag);
  return `${REPO_ISSUES}?${params.toString()}`;
}

export const ISSUES_PAGE = 'https://github.com/habit04/share/issues';
