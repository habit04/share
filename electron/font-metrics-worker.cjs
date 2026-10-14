const { parentPort, workerData } = require('node:worker_threads');
const { readWindowsFontMetrics } = require('./font-metrics.cjs');
const { readWindowsPdfFont } = require('./pdf-font.cjs');
void (workerData.usage === 'pdf' ? readWindowsPdfFont(workerData) : readWindowsFontMetrics(workerData)).then(
  (metrics) => parentPort?.postMessage({ metrics }),
  (error) => parentPort?.postMessage({ error: String(error?.message || 'Installed font metrics unavailable.') }),
).finally(() => parentPort?.close());
