import { describe, expect, it } from 'vitest';
import { createLineScanner, createOutputGate } from '../e2e/output-scanner.mjs';

describe('screenshot output gate', () => {
  it('detects every failure marker split at every byte boundary, including final lines', () => {
    for (const marker of ['PAGE ERROR 💥', 'CONSOLE bad', 'FAIL check', 'prefix Unknown command', '3 check(s) failed']) {
      const bytes = Buffer.from(`fine\r\n${marker}`);
      for (let split = 0; split <= bytes.length; split += 1) {
        const gate = createOutputGate();
        const scan = gate.scanner();
        scan.write(bytes.subarray(0, split));
        scan.write(bytes.subarray(split));
        scan.end();
        expect(gate.problems(), `${marker} split ${split}`).toEqual([marker]);
      }
    }
  });
  it('keeps separate stream lines with a shared exact offline-request allowance', () => {
    const expected = 'CONSOLE Failed to load resource: net::ERR_FAILED';
    const gate = createOutputGate([{ re: /^CONSOLE Failed to load resource: net::ERR_FAILED$/, max: 1 }]);
    const a = gate.scanner(); const b = gate.scanner();
    a.write(Buffer.from(expected.slice(0, 9)));
    b.write(Buffer.from(`${expected}\n`));
    a.write(Buffer.from(`${expected.slice(9)}\nCONSOLE other\n`));
    a.end(); b.end();
    expect(gate.problems()).toEqual([expected, 'CONSOLE other']);
  });
  it('retains only a bounded unfinished line and rejects oversized lines', () => {
    const lines: string[] = []; let overflow = 0;
    const scan = createLineScanner((line) => lines.push(line), () => overflow += 1, 64);
    for (let i = 0; i < 20000; i += 1) { scan.write(Buffer.from('x'.repeat(32))); expect(scan.bufferedChars).toBeLessThanOrEqual(64); }
    scan.write(Buffer.from('\nPAGE ERROR next\n'));
    scan.end();
    expect(overflow).toBe(1);
    expect(lines).toEqual(['x'.repeat(64), 'PAGE ERROR next']);
  });
});
