/** Captured source creation timezone for independent native postflight. */
const contexts = new WeakSet();
const MAX_SOURCE_CHARS = 128 * 1024 * 1024;
const DAY_MS = 86400000n;
const MAX_DAY = 0x7fffffffn;

function invalid(message) {
  const error = new Error('DWG source time context: ' + message + '. Save a DXF copy instead.');
  error.code = 'ERR_DWG_TIME_CONTEXT';
  throw error;
}

/** Decimal arithmetic rounds each declared date to integer milliseconds, without float subtraction. */
function dateMilliseconds(text) {
  if (typeof text !== 'string' || text.length > 64) invalid('invalid creation date');
  const match = /^([+]?)(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d{1,2}))?$/.exec(text);
  if (!match) invalid('invalid creation date');
  const exponent = Number(match[3] || 0);
  const [whole = '', fraction = ''] = match[2].split('.');
  const digits = whole + fraction;
  if (digits.length > 32 || Math.abs(exponent) > 12) invalid('unsupported creation date precision');
  let numerator = BigInt(digits), denominator = 1n;
  const scale = fraction.length - exponent;
  if (scale >= 0) denominator = 10n ** BigInt(scale);
  else numerator *= 10n ** BigInt(-scale);
  if (numerator >= (MAX_DAY + 1n) * denominator) invalid('creation date is outside storage');
  const milliseconds = (numerator * DAY_MS * 2n + denominator) / (denominator * 2n);
  if (milliseconds > MAX_DAY * DAY_MS + DAY_MS - 1n) invalid('rounded creation date is outside storage');
  return milliseconds;
}

/** Only one exactly framed group40 for each known creation variable may establish a context. */
function sourceCreationOffsetMinutes(text) {
  if (typeof text !== 'string' || text.length > MAX_SOURCE_CHARS || text.includes('\0')) invalid('invalid source drawing');
  const dates = new Map();
  let index = 0, section = '', expectSection = false, headers = 0, variable = null, values = [], sawPair = false;
  const nextLine = () => {
    if (index >= text.length) return null;
    const end = text.indexOf('\n', index);
    const result = text.slice(index, end < 0 ? text.length : end).trim();
    index = end < 0 ? text.length : end + 1;
    return result;
  };
  const finishVariable = () => {
    if (variable !== '$TDCREATE' && variable !== '$TDUCREATE') return;
    if (dates.has(variable) || values.length !== 1 || values[0][0] !== 40) invalid('ambiguous creation date framing');
    dates.set(variable, dateMilliseconds(values[0][1]));
  };
  for (;;) {
    const codeText = nextLine();
    if (codeText === null) break;
    if (!sawPair && codeText === '') continue;
    const value = nextLine();
    if (value === null || !/^[+-]?\d+$/.test(codeText)) invalid('invalid source group structure');
    sawPair = true;
    const code = Number(codeText);
    // Match raw inventory capture's trim().parse::<i32>() for ignored groups.
    // The unchanged authoritative portable preflight still requires u16<=1071,
    // at most eight raw code characters, and its established pair budget.
    if (!Number.isInteger(code) || code < -2147483648 || code > 2147483647) invalid('invalid source group code');
    if (expectSection) {
      if (code !== 2) invalid('invalid source section');
      section = value.toUpperCase();
      if (section === 'HEADER' && ++headers !== 1) invalid('duplicate source HEADER');
      expectSection = false;
      variable = null; values = [];
      continue;
    }
    if (code === 0 && value === 'EOF') {
      if (section || text.slice(index).trim()) invalid('invalid source EOF');
      break;
    }
    if (code === 0 && value === 'SECTION') {
      if (section) invalid('nested source section');
      expectSection = true;
      continue;
    }
    if (code === 0 && value === 'ENDSEC') {
      if (section === 'HEADER') finishVariable();
      section = ''; variable = null; values = [];
      continue;
    }
    if (section !== 'HEADER') continue;
    if (code === 0) invalid('unterminated source HEADER');
    if (code === 9) { finishVariable(); variable = value.toUpperCase(); values = []; }
    else if (variable === '$TDCREATE' || variable === '$TDUCREATE') {
      if (values.length >= 2) invalid('ambiguous creation date framing');
      values.push([code, value]);
    }
  }
  if (expectSection || section === 'HEADER') invalid('unterminated source HEADER');
  // Missing date pairs retain the original strict metadata path. No baseline is invented.
  if (!dates.has('$TDCREATE') || !dates.has('$TDUCREATE')) return null;
  const delta = dates.get('$TDCREATE') - dates.get('$TDUCREATE');
  if (delta % 60000n || delta < -14n * 3600000n || delta > 14n * 3600000n) invalid('unsupported creation offset');
  return Number(delta / 60000n);
}

function deriveSourceTimeContext(text, currentOffset = -new Date().getTimezoneOffset()) {
  const offsetMinutes = sourceCreationOffsetMinutes(text);
  if (offsetMinutes === null) return null;
  if (offsetMinutes % 60) {
    if (Number.isInteger(currentOffset) && offsetMinutes === currentOffset) return null;
    invalid('fractional creation offset differs from this host');
  }
  const hours = offsetMinutes / 60;
  const timezone = hours === 0 ? 'Etc/GMT' : `Etc/GMT${hours > 0 ? '-' : '+'}${Math.abs(hours)}`;
  const context = Object.freeze({ schemaVersion: 1, offsetMinutes, timezone });
  contexts.add(context);
  return context;
}

function assertInternalTimeContext(context) {
  if (context === undefined || context === null) return null;
  if (!contexts.has(context)) invalid('untrusted reader context');
  return context;
}

module.exports = { deriveSourceTimeContext, assertInternalTimeContext, sourceCreationOffsetMinutes };
