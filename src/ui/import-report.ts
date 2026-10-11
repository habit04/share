import { modal, button } from './dialogkit';
import { esc } from './dom';
import { countOf, countLines, describeItem, formatImportReport, lossCount, type ImportReport } from '../io/import-report';

/** Items listed in the dialog (the copied report has all of them). */
export const DIALOG_ITEMS = 50;

/**
 * Import report: counts per object type and the first DIALOG_ITEMS objects that opening the
 * drawing dropped, simplified or kept without showing, with Copy Report (the full text).
 * Shown after OPEN when content was lost, and by the IMPORTREPORT command.
 */
export function importReportDialog(report: ImportReport, fileName: string): void {
  const m = modal(report.recovered ? 'Recovered Drawing' : `${report.format} Import Report`, 620, 'dark');
  m.root.classList.add('import-report-dialog');
  const loss = lossCount(report);
  const kept = countOf(report, 'kept');
  const unsupported = countOf(report, 'unsupported');
  const intro = document.createElement('p');
  intro.className = 'import-report-intro';
  const parts: string[] = [];
  if (report.recovered) parts.push(`<b>${esc(fileName)} is damaged:</b> ${esc(report.recovered.message)}. Only what was readable was opened. Check the drawing and save it with Save As.`);
  parts.push(
    `${esc(fileName)}: <b>${loss}</b> object(s) dropped or simplified` +
      (kept ? `, <b>${kept}</b> kept without being shown (written back on save)` : '') +
      (unsupported ? `, <b>${unsupported}</b> not supported yet` : '') +
      '.' +
      (loss && !report.recovered && report.format === 'DXF' ? ' Saving over the original file removes the dropped content: use Save As to keep the original.' : ''),
  );
  intro.innerHTML = parts.join('<br>');
  const counts = document.createElement('ul');
  counts.className = 'import-report-counts';
  for (const line of countLines(report)) {
    const li = document.createElement('li');
    li.textContent = line;
    counts.appendChild(li);
  }
  const list = document.createElement('div');
  list.className = 'import-report-list';
  list.setAttribute('role', 'list');
  for (const item of report.items.slice(0, DIALOG_ITEMS)) {
    const row = document.createElement('div');
    row.className = `import-report-row ${item.action}`;
    row.setAttribute('role', 'listitem');
    row.textContent = describeItem(item);
    list.appendChild(row);
  }
  const more = report.items.length - Math.min(report.items.length, DIALOG_ITEMS) + report.omitted;
  if (more > 0) {
    const row = document.createElement('div');
    row.className = 'import-report-row more';
    row.textContent = `... and ${more} more (Copy Report has the full list).`;
    list.appendChild(row);
  }
  m.body.append(intro, counts);
  if (report.notes.length) {
    const notes = document.createElement('ul');
    notes.className = 'import-report-notes';
    for (const n of report.notes) {
      const li = document.createElement('li');
      li.textContent = n;
      notes.appendChild(li);
    }
    m.body.appendChild(notes);
  }
  m.body.appendChild(list);
  const copy = button('Copy Report');
  copy.className += ' left';
  copy.addEventListener('click', () => {
    const text = formatImportReport(report, fileName);
    const done = () => (copy.textContent = 'Copied');
    // The button says what happened: a copy that failed (no clipboard access) must not look like a success.
    const failed = (reason: string) => {
      copy.textContent = 'Copy failed';
      copy.title = `The report could not be copied to the clipboard${reason ? `: ${reason}` : ''}.`;
    };
    if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(text).then(done, (err: unknown) => fallbackCopy(text, done, () => failed(err instanceof Error ? err.message : String(err))));
    else fallbackCopy(text, done, () => failed(''));
  });
  const close = button('Close', true);
  close.addEventListener('click', () => m.close());
  m.footer.append(copy, close);
}

function fallbackCopy(text: string, done: () => void, failed: () => void): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } finally {
    ta.remove();
  }
  if (ok) done();
  else failed();
}
