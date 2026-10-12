/** Bounded JCad metadata for disabled masks; native groups cannot carry their inactive settings. */
import type { Obj } from './groups';
import type { MTextBackground } from '../../core/mtext';
import { mtextBackgroundProblem } from '../../core/mtext-background';
import { MTEXT_BACKGROUND_APP } from './codes';

export const MAX_BACKGROUND_METADATA_BYTES = 4096;
export const MAX_BACKGROUND_METADATA_CHUNKS = 64;
const keys = new Set(['version', 'flags', 'scale', 'color', 'trueColor', 'colorName', 'transparency']);

/** Count with no byte-buffer allocation, and stop as soon as a string exceeds the bound. */
function boundedUtf8Size(value: string, max: number): number {
  let bytes = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (bytes > max) return bytes;
  }
  return bytes;
}

export function backgroundMetadataChunks(bg: MTextBackground, height: number): string[] {
  const problem = mtextBackgroundProblem({ background: bg, height });
  if (problem || bg.flags !== 0) throw new RangeError(`Invalid inactive MTEXT background settings: ${problem ?? 'flags must be zero'}`);
  // Bound the only variable-size field before JSON.stringify can allocate its encoding.
  if (bg.colorName && boundedUtf8Size(bg.colorName, MAX_BACKGROUND_METADATA_BYTES) > MAX_BACKGROUND_METADATA_BYTES) throw new RangeError('Inactive MTEXT background metadata exceeds 4096 bytes.');
  // Protect literal CAD escapes and whitespace that the tokenizer trims at chunk boundaries.
  const json = JSON.stringify({ version: 1, flags: 0, scale: bg.scale, color: bg.color, ...(bg.trueColor !== undefined ? { trueColor: bg.trueColor } : {}), ...(bg.colorName !== undefined ? { colorName: bg.colorName } : {}), ...(bg.transparency !== undefined ? { transparency: bg.transparency } : {}) }).replace(/\\\\/g, '\\u005c').replace(/\s/gu, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  if (boundedUtf8Size(json, MAX_BACKGROUND_METADATA_BYTES) > MAX_BACKGROUND_METADATA_BYTES) throw new RangeError('Inactive MTEXT background metadata exceeds 4096 bytes.');
  const chunks: string[] = [];
  let chunk = '', bytes = 0;
  for (const ch of json) {
    const size = boundedUtf8Size(ch, 4);
    if (bytes + size > 250) { chunks.push(chunk); chunk = ''; bytes = 0; }
    chunk += ch; bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export function readBackgroundMetadata(o: Obj, height: number): { background?: MTextBackground; problem?: string } {
  const chunks: string[] = [];
  let found = false, active = false, bytes = 0;
  for (const pair of o.groups) {
    if (pair.code === 1001) {
      active = pair.value === MTEXT_BACKGROUND_APP;
      if (active && found) return { problem: 'duplicate application records' };
      if (active) found = true;
      continue;
    }
    if (!active) continue;
    if (pair.code !== 1000) return { problem: 'expected string chunks' };
    if (chunks.length >= MAX_BACKGROUND_METADATA_CHUNKS) return { problem: 'too many chunks' };
    const size = boundedUtf8Size(pair.value, 250);
    if (size > 250) return { problem: 'chunk exceeds 250 UTF-8 bytes' };
    bytes += size;
    if (bytes > MAX_BACKGROUND_METADATA_BYTES) return { problem: 'metadata exceeds 4096 bytes' };
    chunks.push(pair.value);
  }
  if (!found) return {};
  try {
    // Both allocation and parsing are bounded before joining source-controlled chunks.
    const data: unknown = JSON.parse(chunks.join(''));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { problem: 'expected a versioned settings object' };
    const value = data as Record<string, unknown>;
    if (Object.keys(value).some((key) => !keys.has(key)) || value.version !== 1 || value.flags !== 0 || typeof value.scale !== 'number' || (typeof value.color !== 'number' && value.color !== 'ByLayer')) return { problem: 'invalid settings schema' };
    const background = { flags: 0, scale: value.scale, color: value.color, ...(value.trueColor !== undefined ? { trueColor: value.trueColor } : {}), ...(value.colorName !== undefined ? { colorName: value.colorName } : {}), ...(value.transparency !== undefined ? { transparency: value.transparency } : {}) } as MTextBackground;
    const problem = mtextBackgroundProblem({ background, height });
    return problem ? { problem } : { background };
  } catch { return { problem: 'invalid JSON settings' }; }
}
