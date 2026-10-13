const { parentPort, workerData } = require('node:worker_threads');
const { readWindowsFontMetrics } = require('./font-metrics.cjs');
void readWindowsFontMetrics(workerData).then(
  (metrics) => parentPort?.postMessage({ metrics }),
  (error) => parentPort?.postMessage({ error: String(error?.message || 'Installed font metrics unavailable.') }),
).finally(() => parentPort?.close());
