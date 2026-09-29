// BOMSUMMARY: count the components (inserts with a TAG1) by MFG / CAT and show the
// totals in a dialog, with the option to save them as CSV.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const csvCell = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));

/** Rows { mfg, cat, qty, tags } sorted by manufacturer and catalog number. */
function summarize(components) {
  const rows = new Map();
  for (const c of components) {
    const mfg = (c.attributes.MFG || '').trim() || '(no MFG)';
    const cat = (c.attributes.CAT || '').trim() || '(no CAT)';
    const key = `${mfg}\u0000${cat}`;
    const row = rows.get(key) || { mfg, cat, qty: 0, tags: [] };
    row.qty += 1;
    row.tags.push(c.attributes.TAG1);
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => a.mfg.localeCompare(b.mfg) || a.cat.localeCompare(b.cat, undefined, { numeric: true }));
}

jcad.commands.register({
  name: 'BOMSUMMARY',
  aliases: ['BOMSUM'],
  description: 'Count components by manufacturer and catalog number',
  async run(jcad) {
    const rows = summarize(jcad.electrical.components());
    if (rows.length === 0) {
      jcad.ui.log('BOMSUMMARY: no components (inserts with TAG1) in this drawing.');
      return;
    }
    const total = rows.reduce((n, r) => n + r.qty, 0);
    jcad.ui.log(`BOMSUMMARY: ${total} component(s), ${rows.length} catalog line(s).`);
    const body = rows
      .map((r) => `<tr><td>${esc(r.mfg)}</td><td>${esc(r.cat)}</td><td style="text-align:right">${r.qty}</td><td>${esc(r.tags.sort().join(', '))}</td></tr>`)
      .join('');
    const html = `
      <div style="font-size:12px;margin-bottom:6px">${total} component(s) in ${esc(jcad.document.info().fileName)}</div>
      <div style="max-height:320px;overflow:auto;border:1px solid #555">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="text-align:left"><th>MFG</th><th>CAT</th><th style="text-align:right">Qty</th><th>Tags</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
    const choice = await jcad.ui.openDialog({ title: 'BOM Summary', width: 620, html, buttons: ['Close', 'Save CSV...'] });
    if (choice === 'Save CSV...') {
      const csv = ['MFG,CAT,QTY,TAGS', ...rows.map((r) => [r.mfg, r.cat, r.qty, r.tags.join(' ')].map(csvCell).join(','))].join('\r\n');
      const saved = await jcad.files.saveText('bom-summary.csv', csv, 'CSV');
      if (saved) jcad.ui.log(`BOM summary saved to ${saved}.`);
    }
  },
});
