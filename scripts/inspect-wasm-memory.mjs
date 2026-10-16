// Inspect a WebAssembly binary's memory section (section 5) and import section
// (section 2) without instantiating it. Prints JSON:
//   { memories: [{imported, shared, initialPages, maximumPages|null}],
//     initialBytes, maximumBytes|null }
// Used by scripts/build-qpdf-wasm.sh to prove the production qpdf artifact
// declares the pinned maximum linear memory (768 MiB = 12288 pages), and by
// the restricted-PDF tests to assert the shipped artifact stays capped.
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) { console.error('usage: inspect-wasm-memory.mjs <file.wasm>'); process.exit(2); }
const bytes = readFileSync(path);
let pos = 8; // magic + version
const u8 = () => bytes[pos++];
const uleb = () => {
  let result = 0, shift = 0;
  for (;;) { const b = u8(); result |= (b & 0x7f) * 2 ** shift; if (!(b & 0x80)) return result; shift += 7; }
};
const readName = () => { const n = uleb(); const s = bytes.toString('utf8', pos, pos + n); pos += n; return s; };
const memories = [];
while (pos < bytes.length) {
  const id = u8(); const size = uleb(); const end = pos + size;
  if (id === 2) { // imports
    const count = uleb();
    for (let i = 0; i < count; i++) {
      readName(); readName(); const kind = u8();
      if (kind === 0x02) { // memory import
        const flags = uleb(); const shared = (flags & 0x02) !== 0;
        const initial = uleb(); const maximum = (flags & 0x01) ? uleb() : null;
        memories.push({ imported: true, shared, initialPages: initial, maximumPages: maximum });
      } else if (kind === 0x00) { uleb(); } // func: type index
      else if (kind === 0x01) { const f = uleb(); uleb(); if (f & 0x01) uleb(); } // table
      else if (kind === 0x03) { uleb(); } // global
    }
  } else if (id === 5) { // memory section
    const count = uleb();
    for (let i = 0; i < count; i++) {
      const flags = uleb(); const shared = (flags & 0x02) !== 0;
      const initial = uleb(); const maximum = (flags & 0x01) ? uleb() : null;
      memories.push({ imported: false, shared, initialPages: initial, maximumPages: maximum });
    }
  }
  pos = end;
}
const page = 65536;
const out = {
  memories,
  initialBytes: memories.length ? memories[0].initialPages * page : null,
  maximumBytes: memories.length && memories[0].maximumPages !== null ? memories[0].maximumPages * page : null,
};
console.log(JSON.stringify(out));
