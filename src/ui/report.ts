/**
 * Help > Report a Problem: collects a description plus diagnostics (version,
 * platform, command history, captured errors) and hands it on as a prefilled
 * GitHub issue, a clipboard copy, or a saved report file for e-mail. Attaching
 * the current drawing is opt-in.
 */
import type { Editor } from '../app/editor';
import { modal, button } from './dialogkit';
import { esc } from './dom';
import { diagnosticEntries, issueUrl, reportText, ISSUES_PAGE, type ReportInput } from '../app/diagnostics';
import { APP_VERSION_LABEL } from './help';
import { writeDxf } from '../io/dxf';
import { withoutUnusedLibraryBlocks } from '../electrical/library';
import { exportFailed } from '../app/file-error-text';
import { supportContact } from '../app/about';

interface AppInfo {
  version: string;
  platform: string;
  arch: string;
}

async function appInfo(): Promise<AppInfo> {
  const b = window.jcad;
  if (b?.appInfo) {
    try {
      const i = await b.appInfo();
      return { version: i.version, platform: i.platform, arch: i.arch };
    } catch {
      /* fall through */
    }
  }
  return { version: APP_VERSION_LABEL, platform: b?.platform ?? 'browser', arch: typeof navigator !== 'undefined' ? navigator.platform : '' };
}

function textarea(placeholder: string, rows: number): HTMLTextAreaElement {
  const t = document.createElement('textarea');
  t.className = 'input report-text';
  t.placeholder = placeholder;
  t.rows = rows;
  t.spellcheck = true;
  t.addEventListener('keydown', (ev) => ev.stopPropagation());
  return t;
}

function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const r = document.createElement('label');
  r.className = 'report-row';
  r.innerHTML = `<span>${esc(label)}</span>`;
  r.appendChild(control);
  if (hint) {
    const h = document.createElement('small');
    h.className = 'dlg-note';
    h.textContent = hint;
    r.appendChild(h);
  }
  return r;
}

/** REPORTBUG / Help > Report a Problem. */
export function reportProblemDialog(editor: Editor, kind: 'bug' | 'feedback' = 'bug'): void {
  const m = modal(kind === 'bug' ? 'Report a Problem' : 'Send Feedback', 640, 'dark');
  const intro = document.createElement('p');
  intro.className = 'dlg-note';
  intro.textContent =
    kind === 'bug'
      ? 'Describe what went wrong. The report includes the version and platform. You can choose to include recent commands and captured errors. Local paths and drawing names are omitted unless you opt in. Drawings are only attached when you tick the box.'
      : 'Tell us what is missing or what would make JCad Electrical better for your work.';
  m.body.appendChild(intro);

  const title = document.createElement('input');
  title.className = 'input';
  title.placeholder = kind === 'bug' ? 'Short summary, e.g. "Wire numbers skip rung 103"' : 'Short summary';
  title.addEventListener('keydown', (ev) => ev.stopPropagation());
  const happened = textarea(kind === 'bug' ? 'What did you do and what went wrong? Name the command if you know it.' : 'What would you like to be able to do?', 4);
  const expected = textarea(kind === 'bug' ? 'What should have happened instead? (What AutoCAD Electrical does is a good reference.)' : 'How does another program do it, if you know?', 3);
  const steps = textarea('1. Open ...\n2. Run ...\n3. Click ...', 3);
  m.body.append(row('Summary', title), row('What happened', happened), row(kind === 'bug' ? 'What you expected' : 'Reference', expected));
  if (kind === 'bug') m.body.appendChild(row('Steps to reproduce', steps));

  const opts = document.createElement('div');
  opts.className = 'report-opts';
  const histBox = document.createElement('input');
  histBox.type = 'checkbox';
  histBox.checked = false;
  const errBox = document.createElement('input');
  errBox.type = 'checkbox';
  errBox.checked = false;
  const privateBox = document.createElement('input');
  privateBox.type = 'checkbox';
  const dwgBox = document.createElement('input');
  dwgBox.type = 'checkbox';
  const errs = diagnosticEntries();
  opts.innerHTML = '';
  const optRow = (box: HTMLInputElement, text: string) => {
    const l = document.createElement('label');
    l.append(box, document.createTextNode(` ${text}`));
    opts.appendChild(l);
  };
  optRow(histBox, `Include the last ${Math.min(40, editor.history.length)} command-line entries`);
  optRow(errBox, `Include captured errors (${errs.length})`);
  optRow(privateBox, 'Include local file paths and drawing names');
  optRow(dwgBox, `Attach the current drawing as DXF when saving the report (${esc(editor.fileName())})`);
  m.body.appendChild(opts);

  const preview = document.createElement('pre');
  preview.className = 'report-preview';
  m.body.appendChild(preview);

  const status = document.createElement('div');
  status.className = 'dlg-note';
  m.body.appendChild(status);
  const contact = supportContact();
  if (contact) {
    const row = document.createElement('p'); row.className = 'dlg-note';
    row.append('You can also email bugs or feature requests to ');
    const link = document.createElement('a'); link.href = contact.url; link.textContent = contact.email;
    link.style.color = 'var(--accent)';
    link.addEventListener('click', (ev) => {
      if (window.jcad?.openExternal) { ev.preventDefault(); void window.jcad.openExternal(contact.url); }
    });
    row.append(link, '. Use Copy Report or Save Report to include details and attach any files in your email app.');
    m.body.append(row);
  }

  let info: AppInfo = { version: APP_VERSION_LABEL, platform: window.jcad?.platform ?? 'browser', arch: '' };
  const input = (): ReportInput => ({
    title: title.value.trim(),
    happened: happened.value.trim(),
    expected: expected.value.trim(),
    steps: steps.value.trim(),
    version: info.version,
    platform: info.platform,
    arch: info.arch,
    history: histBox.checked ? editor.history : [],
    errors: errBox.checked ? errs : [],
    drawingName: editor.fileName(),
    includePrivateDetails: privateBox.checked,
    extra: [`Symbol standard: ${editor.settings.symbolStandard}`, `Open drawings: ${editor.sessions.all.length}`],
  });
  const refresh = () => {
    preview.textContent = reportText(input());
  };
  void appInfo().then((i) => {
    info = i;
    refresh();
  });
  for (const el of [title, happened, expected, steps, histBox, errBox, privateBox]) el.addEventListener('input', refresh);
  refresh();

  const canSend = () => {
    if (!happened.value.trim()) {
      status.textContent = 'Please describe what happened first.';
      happened.focus();
      return false;
    }
    return true;
  };

  const openIssue = button('Open GitHub Issue', true);
  openIssue.title = 'Opens a prefilled bug report on GitHub (a GitHub account is needed to submit it).';
  openIssue.addEventListener('click', () => {
    if (!canSend()) return;
    const url = kind === 'bug' ? issueUrl(input()) : `${ISSUES_PAGE}/new?template=feature_request.yml&title=${encodeURIComponent('[Feature] ' + (title.value.trim() || happened.value.trim().slice(0, 80)))}&request=${encodeURIComponent(happened.value.trim())}&reference=${encodeURIComponent(expected.value.trim())}&version=${encodeURIComponent(info.version)}`;
    const opened = window.jcad?.openExternal ? window.jcad.openExternal(url) : Promise.resolve(Boolean(window.open(url, '_blank', 'noopener')));
    void opened.then((ok) => {
      status.textContent = ok ? 'Your browser opened the GitHub issue form; review it and press Submit. Drag the DXF or a screenshot onto the form to attach it.' : 'Could not open the browser. Use Copy Report or Save Report instead.';
      editor.log(ok ? 'Problem report opened on GitHub.' : 'Could not open the GitHub issue form.');
    });
  });
  const copy = button('Copy Report');
  copy.addEventListener('click', () => {
    if (!canSend()) return;
    void navigator.clipboard?.writeText(reportText(input())).then(
      () => (status.textContent = 'Report copied to the clipboard; paste it into an e-mail or an issue.'),
      () => (status.textContent = 'Clipboard access was refused; use Save Report instead.'),
    );
  });
  const save = button('Save Report…');
  save.addEventListener('click', () => {
    if (!canSend()) return;
    void (async () => {
      const bridge = editor.fileBridge;
      const base = `jcad-report-${new Date().toISOString().slice(0, 10)}`;
      if (!bridge?.saveText) {
        // Browser preview: download the text file.
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([reportText(input())], { type: 'text/plain' }));
        a.download = `${base}.txt`;
        a.click();
        status.textContent = 'Report downloaded.';
        return;
      }
      // A failed write is shown in the dialog and logged (not lost as an unhandled rejection).
      let error = '';
      const failed = (name: string) =>
        exportFailed((t) => {
          error = t;
          status.textContent = t;
          editor.log(t);
        }, name);
      const reportName = `${base}.txt`;
      const p = await bridge.saveText(reportName, reportText(input()), 'Problem report', 'txt').catch(failed(reportName));
      if (!p) return;
      let msg = `Report saved to ${p}.`;
      if (dwgBox.checked) {
        const dxf = writeDxf(withoutUnusedLibraryBlocks(editor.doc.snapshot));
        const dxfName = `${base}-${editor.fileName().replace(/\.(dxf|dwg)$/i, '')}.dxf`;
        const d = await bridge.saveText(dxfName, dxf, 'DXF Drawing', 'dxf').catch(failed(dxfName));
        if (d) msg += ` Drawing saved to ${d}.`;
        else if (error) msg += ` ${error}`;
      }
      msg += ' E-mail both files or attach them to a GitHub issue.';
      status.textContent = msg;
      editor.log(msg);
    })();
  });
  const close = button('Close');
  close.addEventListener('click', () => m.close());
  m.footer.append(openIssue, copy, save, close);
  setTimeout(() => title.focus(), 0);
}
