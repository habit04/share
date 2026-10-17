const { parentPort, workerData } = require('node:worker_threads');
const { readWindowsFontMetrics } = require('./font-metrics.cjs');
const { readWindowsPdfFont } = require('./pdf-font.cjs');
// The shaping reader loads only inside a shape worker, for its one
// job, so a metrics or PDF worker never parses the shaping chain or
// touches the vendored engine assets (correction 3, mirroring the
// host's lazy validator).
const read = workerData.usage === 'pdf'
  ? readWindowsPdfFont
  : workerData.usage === 'shape'
    ? (request) => require('./shaping/shape-font.cjs').readWindowsShapedFont(request)
    : readWindowsFontMetrics;
void read(workerData).then(
  (metrics) => parentPort?.postMessage({ metrics }),
  (error) => parentPort?.postMessage({ error: String(error?.message || 'Installed font metrics unavailable.') }),
).finally(() => parentPort?.close());
