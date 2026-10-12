/** Parent-owned Linux RSS/HWM measurements for Electron utility processes. */
'use strict';
const fs = require('node:fs');

const MAX_STATUS_BYTES = 64 * 1024;
const MAX_STAT_BYTES = 16 * 1024;
const MAX_MEMORY_KIB = Math.floor(Number.MAX_SAFE_INTEGER / 1024);

function invalidMetrics() { return new Error('The DWG reader Linux process measurement is unavailable or changed.'); }
function validPid(pid) { return Number.isSafeInteger(pid) && pid > 0; }

/**
 * proc files advertise size zero. Read through one owned descriptor into a fixed buffer,
 * including an overflow byte; never size a buffer from fstat or accept a child-supplied path.
 */
function readProcFile(pid, name, limit, files) {
  if (!validPid(pid) || !['stat', 'status'].includes(name)) throw invalidMetrics();
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = files.openSync(`/proc/${pid}/${name}`, flags);
  try {
    if (!files.fstatSync(descriptor).isFile()) throw invalidMetrics();
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = files.readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!Number.isSafeInteger(count) || count < 0 || count > buffer.length - length) throw invalidMetrics();
      if (count === 0) break;
      length += count;
    }
    if (length > limit) throw invalidMetrics();
    return buffer.toString('utf8', 0, length);
  } finally { files.closeSync(descriptor); }
}

/** Parse field 22 after the final closing comm parenthesis; comm may contain spaces/parens. */
function parseProcStat(text, pid) {
  if (typeof text !== 'string' || text.includes('\0') || Buffer.byteLength(text) > MAX_STAT_BYTES || !validPid(pid)) throw invalidMetrics();
  const prefix = /^([1-9][0-9]*) \(/.exec(text);
  const close = text.lastIndexOf(') ');
  if (!prefix || prefix[1] !== String(pid) || close < prefix[0].length) throw invalidMetrics();
  const suffix = text.slice(close + 2);
  if (!/^[^\r\n]*\n?$/.test(suffix)) throw invalidMetrics();
  const fields = suffix.trim().split(/[\t ]+/);
  // The suffix begins with field 3 (state); index 19 is field 22 (starttime in clock ticks).
  // Linux has fields through 52 (since 3.5); reject truncated or nonnumeric records as well.
  if (fields.length < 50 || !/^[RSDTtWKIP]$/.test(fields[0]) || fields.slice(1).some((field) => !/^-?[0-9]+$/.test(field)) ||
      !/^[1-9][0-9]{0,19}$/.test(fields[19]) || BigInt(fields[19]) > 18_446_744_073_709_551_615n) throw invalidMetrics();
  return fields[19]; // Compare exact integers without losing precision to JavaScript Number.
}

/** Linux documents VmRSS and VmHWM in kB (KiB), matching the watchdog's input units. */
function parseProcStatus(text, pid) {
  if (typeof text !== 'string' || text.includes('\0') || Buffer.byteLength(text) > MAX_STATUS_BYTES || !validPid(pid)) throw invalidMetrics();
  const wanted = new Map();
  for (const line of text.split('\n')) {
    const match = /^(Pid|Tgid|VmRSS|VmHWM):[\t ]*(.*?)[\t ]*$/.exec(line);
    if (!match) continue;
    if (wanted.has(match[1])) throw invalidMetrics();
    wanted.set(match[1], match[2]);
  }
  if (wanted.get('Pid') !== String(pid) || wanted.get('Tgid') !== String(pid)) throw invalidMetrics();
  const memory = (name) => {
    const match = /^([0-9]+)[\t ]+kB$/.exec(wanted.get(name) ?? '');
    if (!match) throw invalidMetrics();
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_MEMORY_KIB) throw invalidMetrics();
    return value;
  };
  const workingSetSize = memory('VmRSS');
  const peakWorkingSetSize = memory('VmHWM');
  if (peakWorkingSetSize < workingSetSize) throw invalidMetrics();
  return { workingSetSize, peakWorkingSetSize };
}

/**
 * Enrich only the target's unique Electron Utility record. Linux never depends on Electron's
 * undocumented memory member: proc supplies RSS/HWM, while Electron supplies PID/type/time.
 * A stat/status/stat identity bracket detects PID reuse during the sample, and the first valid
 * identity is retained across calls. Missing Electron records are left to the watchdog's grace
 * and fail-closed policy; malformed, unreadable or raced proc measurements throw immediately.
 * @param {{ pid: number, getMetrics: () => any[], platform?: NodeJS.Platform, fs?: typeof fs }} options
 */
function createProcessMetricsReader({ pid, getMetrics, platform = process.platform, fs: files = fs }) {
  if (!validPid(pid) || typeof getMetrics !== 'function') throw invalidMetrics();
  /** @type {{ startTicks: string, creationTime: number } | null} */
  let identity = null;
  return () => {
    const metrics = getMetrics();
    if (platform !== 'linux') return metrics;
    if (!Array.isArray(metrics)) throw invalidMetrics();
    const matching = metrics.filter((metric) => metric?.pid === pid);
    if (matching.length === 0) return metrics;
    if (matching.length !== 1) throw invalidMetrics();
    const target = matching[0];
    if (target.type !== 'Utility' || !Number.isFinite(target.creationTime) || target.creationTime <= 0) throw invalidMetrics();
    const before = parseProcStat(readProcFile(pid, 'stat', MAX_STAT_BYTES, files), pid);
    const memory = parseProcStatus(readProcFile(pid, 'status', MAX_STATUS_BYTES, files), pid);
    const after = parseProcStat(readProcFile(pid, 'stat', MAX_STAT_BYTES, files), pid);
    if (before !== after || (identity && (identity.startTicks !== before || identity.creationTime !== target.creationTime))) throw invalidMetrics();
    identity = { startTicks: before, creationTime: target.creationTime };
    return metrics.map((metric) => metric === target ? { ...metric, memory } : metric);
  };
}

module.exports = { createProcessMetricsReader, parseProcStat, parseProcStatus, MAX_STATUS_BYTES, MAX_STAT_BYTES };
