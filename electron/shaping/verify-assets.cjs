/**
 * Vendored shaping-engine asset verification (12.5 engine switch-over;
 * contract v4 §9.2; mirrors the restricted-PDF host's verifyAssets
 * discipline from milestone 12.4).
 *
 * The shaping worker loads the capped HarfBuzz build ONLY through
 * this gate: every vendored file must hash to the build receipt, and
 * the wasm binary's DECLARED linear-memory maximum — parsed from the
 * binary's own memory section, never trusted from metadata — must be
 * exactly 256 MiB. A swapped, stock (2 GiB), or otherwise uncapped
 * artifact fails verification and shaping is unavailable; there is
 * no fallback artifact.
 */
'use strict';
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const ASSETS = path.join(__dirname, 'assets');
const PAGE_BYTES = 65536;
const REQUIRED_MAXIMUM_BYTES = 256 * 1024 * 1024;

function lebReader(bytes, offset) {
  let value = 0;
  let shift = 0;
  let at = offset;
  for (;;) {
    if (at >= bytes.length) throw new Error('Shaping asset wasm is truncated.');
    const byte = bytes[at];
    at += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error('Shaping asset wasm has an invalid LEB128 value.');
  }
  return { value, next: at };
}

/**
 * The declared maximum linear memory (bytes) of the module's single
 * memory, parsed from the binary: defined memories live in section 5,
 * imported memories in section 2 (import kind 0x02). Returns null
 * when the module declares no maximum or no memory at all.
 */
function declaredMaximumMemory(wasm) {
  let at = 8; // magic + version
  let maximumPages = null;
  let memories = 0;
  const readLimits = (offset) => {
    const flags = lebReader(wasm, offset);
    let cursor = flags.next;
    const initial = lebReader(wasm, cursor);
    cursor = initial.next;
    let max = null;
    if ((flags.value & 0x01) !== 0) {
      const parsed = lebReader(wasm, cursor);
      max = parsed.value;
      cursor = parsed.next;
    }
    return { max, next: cursor };
  };
  while (at < wasm.length) {
    const sectionId = wasm[at];
    const size = lebReader(wasm, at + 1);
    const bodyStart = size.next;
    const bodyEnd = bodyStart + size.value;
    if (bodyEnd > wasm.length) throw new Error('Shaping asset wasm is truncated.');
    if (sectionId === 5) {
      const count = lebReader(wasm, bodyStart);
      let cursor = count.next;
      for (let i = 0; i < count.value; i += 1) {
        const limits = readLimits(cursor);
        cursor = limits.next;
        memories += 1;
        maximumPages = limits.max;
      }
    } else if (sectionId === 2) {
      const count = lebReader(wasm, bodyStart);
      let cursor = count.next;
      const readName = (offset) => {
        const length = lebReader(wasm, offset);
        return length.next + length.value;
      };
      for (let i = 0; i < count.value; i += 1) {
        cursor = readName(cursor); // module
        cursor = readName(cursor); // name
        const kind = wasm[cursor];
        cursor += 1;
        if (kind === 0x02) {
          const limits = readLimits(cursor);
          cursor = limits.next;
          memories += 1;
          maximumPages = limits.max;
        } else if (kind === 0x00) {
          const parsed = lebReader(wasm, cursor); // function type index
          cursor = parsed.next;
        } else if (kind === 0x01) {
          const limits = readLimits(cursor);
          cursor = limits.next;
        } else if (kind === 0x03) {
          cursor += 2; // global: value type + mutability
        } else {
          throw new Error('Shaping asset wasm has an unknown import kind.');
        }
      }
    }
    at = bodyEnd;
  }
  if (memories !== 1 || maximumPages === null) return null;
  return maximumPages * PAGE_BYTES;
}

function verifyAssets(assetsDir = ASSETS) {
  const receipt = JSON.parse(readFileSync(path.join(assetsDir, 'build-receipt.json'), 'utf8'));
  for (const [name, expected] of Object.entries(receipt.files ?? {})) {
    const bytes = readFileSync(path.join(assetsDir, name));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== expected.bytes || sha256 !== expected.sha256) {
      throw new Error(`Shaping asset ${name} does not match its build receipt.`);
    }
    if (name.endsWith('.wasm')) {
      const declared = declaredMaximumMemory(bytes);
      if (declared !== REQUIRED_MAXIMUM_BYTES || receipt.declaredMaximumMemoryBytes !== REQUIRED_MAXIMUM_BYTES) {
        throw new Error('Shaping asset wasm does not declare the required 256 MiB memory maximum.');
      }
    }
  }
  return receipt;
}

module.exports = { verifyAssets, declaredMaximumMemory, REQUIRED_MAXIMUM_BYTES, ASSETS };
