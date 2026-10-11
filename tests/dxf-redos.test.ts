/**
 * Security review E-6: text from a DXF file must be processed in linear time. The tokenizer's
 * trailing-whitespace regex (/\s+$/) and the field-expression regexes backtracked quadratically
 * on a long run of spaces that does not end the line (or has no closing ">%"), so one crafted
 * line froze the renderer for minutes. The replacements must give exactly what the regular
 * expressions gave (checked against them on random text) in bounded time on 10 MB inputs.
 */
import { describe, it, expect } from 'vitest';
import { tokenize } from '../src/io/dxf/groups';
import { readDxf } from '../src/io/dxf';
import { evaluateFields, replaceFields, splitArgs } from '../src/core/fields';

const MB10 = 10 * 1024 * 1024;
/** A minimal DXF: one TEXT on `layer` with `text`. */
const dxfWith = (layer: string, text: string) => ['0', 'SECTION', '2', 'ENTITIES', '0', 'TEXT', '8', layer, '10', '0', '20', '0', '40', '2.5', '1', text, '0', 'ENDSEC', '0', 'EOF', ''].join('\n');
const timed = <T>(fn: () => T): { value: T; ms: number } => {
  const t = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t };
};

/** Deterministic pseudo-random strings over an alphabet that exercises the patterns. */
function* randomStrings(alphabet: readonly string[], count: number, maxLen: number): Generator<string> {
  let seed = 0x2f6e2b1;
  const next = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed;
  };
  for (let n = 0; n < count; n += 1) {
    const len = next() % maxLen;
    let s = '';
    for (let i = 0; i < len; i += 1) s += alphabet[next() % alphabet.length];
    yield s;
  }
}

describe('DXF tokenizer: trailing whitespace in linear time (E-6)', () => {
  it('a 10 MB line of spaces followed by another character tokenizes in bounded time', () => {
    const value = `${' '.repeat(MB10)}x`;
    const { value: pairs, ms } = timed(() => tokenize(['0', 'SECTION', '2', 'ENTITIES', '8', value, '0', 'ENDSEC', '0', 'EOF', ''].join('\n')));
    expect(pairs.find((p) => p.code === 8)!.value).toBe(value);
    // The regex needed hours here (quadratic); a linear pass takes milliseconds. Generous for loaded CI.
    expect(ms).toBeLessThan(5000);
  });

  it('a 10 MB line of spaces alone becomes an empty value, also through readDxf', () => {
    const { value: s, ms } = timed(() => readDxf(dxfWith(' '.repeat(MB10), 'A')));
    expect(ms).toBeLessThan(10_000);
    expect(s.entities).toHaveLength(1);
    expect(s.entities[0]!.layer).toBe(''); // the value is the empty string, as the regex gave
  });

  it('strips exactly what /\\s+$/ stripped (every Unicode space and line terminator)', () => {
    const alphabet = ['a', ' ', '\t', '\v', '\f', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', '　', '﻿', '​', 'x'];
    for (const s of randomStrings(alphabet, 3000, 12)) {
      const pairs = tokenize(['0', 'SECTION', '2', 'ENTITIES', '8', `L${s}`, '0', 'ENDSEC', '0', 'EOF'].join('\n'));
      expect(pairs.find((p) => p.code === 8)!.value, JSON.stringify(s)).toBe(`L${s}`.replace(/\s+$/, ''));
    }
  });

  it('text chunks (groups 1 / 3) keep their trailing spaces', () => {
    const pairs = tokenize(['0', 'SECTION', '2', 'ENTITIES', '1', 'ABC  ', '3', 'DEF ', '0', 'ENDSEC', '0', 'EOF'].join('\n'));
    expect(pairs.filter((p) => p.code === 1 || p.code === 3).map((p) => p.value)).toEqual(['ABC  ', 'DEF ']);
  });
});

describe('field expressions in linear time (E-6)', () => {
  // The expressions the scanner replaces, kept here as the reference.
  const FIELD_RE = /%<\\([A-Za-z_]+)(?:\.[\d.]+)?\s+((?:(?!%<|>%)[\s\S])*?)>%/g;
  const regexReplace = (text: string, fn: (kind: string, args: string) => string) => text.replace(FIELD_RE, (_m, kind: string, args: string) => fn(kind, args));
  const regexSplit = (args: string) => {
    const m = /^(.*?)\s*\\f\s*"([^"]*)"\s*$/.exec(args.trim());
    return m ? { name: m[1]!.trim(), format: m[2]! } : { name: args.trim(), format: null };
  };

  it('finds the same expressions as the regular expression did (random text)', () => {
    const alphabet = ['%<\\', '%<', '>%', '%', '<', '>', '\\', 'AcVar', 'A', '_', '.', '1', ' ', '\n', '\t', 'x', 'Date', '\\f', '"'];
    const fn = (kind: string, args: string) => `[${kind}|${args}]`;
    for (const s of randomStrings(alphabet, 5000, 14)) expect(replaceFields(s, fn), JSON.stringify(s)).toBe(regexReplace(s, fn));
  });

  it('splits "name \\f "format"" like the regular expression did (random text)', () => {
    const alphabet = ['Date', ' ', '\\f', '"', 'M/d', '\n', '\\', 'f', 'x', '\t'];
    for (const s of randomStrings(alphabet, 5000, 10)) expect(splitArgs(s), JSON.stringify(s)).toEqual(regexSplit(s));
    expect(splitArgs('Filename \\f "%fn2"')).toEqual({ name: 'Filename', format: '%fn2' });
  });

  it('a 10 MB run of spaces in a field expression is evaluated in bounded time', () => {
    const open = `%<\\AcVar${' '.repeat(MB10)}x`;
    expect(timed(() => evaluateFields(open)).ms).toBeLessThan(5000);
    const closed = `%<\\AcVar Filename${' '.repeat(MB10)}x \\f "%fn2">%`;
    const r = timed(() => evaluateFields(closed, { filePath: '/jobs/panel.dxf' }));
    expect(r.ms).toBeLessThan(5000);
    // Many unterminated expressions: still one pass.
    const many = '%<\\AcVar '.repeat(200_000);
    expect(timed(() => evaluateFields(many)).ms).toBeLessThan(5000);
    // Through the reader (fields are evaluated on open).
    expect(timed(() => readDxf(dxfWith('0', open))).ms).toBeLessThan(10_000);
  });

  it('still evaluates nested expressions innermost first', () => {
    expect(evaluateFields('A %<\\AcVar Filename \\f "%fn2">% B', { filePath: '/jobs/panel.dxf' })).toBe('A panel B');
    expect(replaceFields('%<\\AcExpr (%<\\AcVar Date>%)>%', (k) => `<${k}>`)).toBe('%<\\AcExpr (<AcVar>)>%');
  });
});
