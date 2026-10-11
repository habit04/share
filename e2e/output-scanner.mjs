// Scanning the screenshot scripts' output for failure lines (e2e/run-screenshots.mjs): whole lines
// across chunk boundaries and UTF-8 sequences, each unfinished line bounded. Ported from PR #2
// (codex/electrical-review-fixes 2f89b0e).
import { StringDecoder } from 'node:string_decoder';

export const BAD_OUTPUT = [/^PAGE ERROR\b/, /^CONSOLE\b/, /^FAIL\b/, /Unknown command/, /\bcheck\(s\) failed\b/];

// Keep only an unfinished line, capped independently of the amount of process output.
// StringDecoder preserves UTF-8 characters even when their bytes arrive in separate chunks.
export function createLineScanner(onLine, onOverflow, maxChars = 8192) {
  const decoder = new StringDecoder('utf8');
  let tail = '';
  let overflow = false;
  const accept = (text) => {
    let start = 0;
    for (;;) {
      const end = text.indexOf('\n', start);
      const fragment = text.slice(start, end < 0 ? undefined : end);
      if (tail.length + fragment.length > maxChars) {
        if (!overflow) onOverflow();
        overflow = true;
        tail = (tail + fragment.slice(-maxChars)).slice(-maxChars);
      } else tail += fragment;
      if (end < 0) break;
      onLine(tail.endsWith('\r') ? tail.slice(0, -1) : tail);
      tail = '';
      overflow = false;
      start = end + 1;
    }
  };
  return {
    write(chunk) { accept(decoder.write(chunk)); },
    end() { accept(decoder.end()); if (tail) onLine(tail.endsWith('\r') ? tail.slice(0, -1) : tail); tail = ''; },
    get bufferedChars() { return tail.length; },
  };
}

export function createOutputGate(allow = []) {
  const problems = [];
  const counts = new Map();
  let omitted = 0;
  const problem = (line) => { if (problems.length < 100) problems.push(line); else omitted += 1; };
  const line = (value) => {
    if (!BAD_OUTPUT.some((re) => re.test(value))) return;
    const permitted = allow.find((item) => item.re.test(value));
    if (permitted) {
      const count = (counts.get(permitted) ?? 0) + 1;
      counts.set(permitted, count);
      if (count <= permitted.max) return;
    }
    problem(value);
  };
  return {
    scanner: () => createLineScanner(line, () => problem('output line exceeded 8192 characters')),
    problems: () => [...problems, ...(omitted ? [`${omitted} additional output errors omitted`] : [])],
  };
}
