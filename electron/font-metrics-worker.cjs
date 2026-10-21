const { parentPort, workerData } = require('node:worker_threads');
const { readWindowsFontMetrics } = require('./font-metrics.cjs');
const { readWindowsPdfFont } = require('./pdf-font.cjs');
const { readWindowsShapedFont } = require('./shaping/shape-font.cjs');
const read = workerData.usage === 'pdf'
  ? readWindowsPdfFont
  : workerData.usage === 'shape'
    ? readWindowsShapedFont
    : readWindowsFontMetrics;
void read(workerData).then(
  (metrics) => parentPort?.postMessage({ metrics }),
  (error) => parentPort?.postMessage({ error: String(error?.message || 'Installed font metrics unavailable.') }),
).finally(() => parentPort?.close());
