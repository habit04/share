import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { decodeDxfBytes, decodeUnicodeEscapes, escapeNonAscii, encodeDxfText, sniffDxfHeader, encodingForCodepage, acadVersionNumber, isUtf8Version } from '../src/io/encoding';
// @ts-expect-error plain JS helper shared with Electron main / CLI
import { decodeDxfBytes as decodeDxfBytesNode } from '../scripts/dwg-reader.mjs';
import { readDxf, writeDxf } from '../src/io/dxf';
import { Drawing } from '../src/core/document';
import { newId, type TextEntity, type MTextEntity } from '../src/core/entities';
import { autosaveName } from '../src/app/autosave';

/** A minimal DXF (header + one TEXT) with the text value given as raw bytes. */
function dxfBytes(acadver: string, codepage: string | null, textBytes: number[], opts: { bom?: boolean } = {}): Uint8Array {
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  const head = ascii(`0\r\nSECTION\r\n2\r\nHEADER\r\n9\r\n$ACADVER\r\n1\r\n${acadver}\r\n${codepage ? `9\r\n$DWGCODEPAGE\r\n3\r\n${codepage}\r\n` : ''}0\r\nENDSEC\r\n0\r\nSECTION\r\n2\r\nENTITIES\r\n0\r\nTEXT\r\n8\r\n0\r\n10\r\n0\r\n20\r\n0\r\n40\r\n0.2\r\n1\r\n`);
  const tail = ascii('\r\n0\r\nENDSEC\r\n0\r\nEOF\r\n');
  return new Uint8Array([...(opts.bom ? [0xef, 0xbb, 0xbf] : []), ...head, ...textBytes, ...tail]);
}

const textOf = (bytes: Uint8Array): string => {
  const state = readDxf(decodeDxfBytes(bytes).text);
  const t = state.entities.find((e): e is TextEntity => e.type === 'text');
  return t?.text ?? '';
};

describe('DXF code pages', () => {
  it('reads the header as latin1 before decoding', () => {
    expect(sniffDxfHeader(dxfBytes('AC1015', 'ANSI_932', [0x41]))).toEqual({ acadver: 'AC1015', codepage: 'ANSI_932' });
    expect(sniffDxfHeader(readFileSync('fixtures/example_2000.dxf'))).toEqual({ acadver: 'AC1015', codepage: 'ANSI_1252' });
    expect(acadVersionNumber('AC1021')).toBe(1021);
    expect(isUtf8Version('AC1018')).toBe(false);
    expect(isUtf8Version('AC1032')).toBe(true);
  });

  it('decodes each ANSI code page with TextDecoder', () => {
    expect(textOf(dxfBytes('AC1015', 'ANSI_1252', [0x4d, 0x6f, 0x74, 0x65, 0x75, 0x72, 0x20, 0xe9, 0x80]))).toBe('Moteur é€');
    expect(textOf(dxfBytes('AC1015', 'ANSI_932', [0x93, 0xfa, 0x96, 0x7b]))).toBe('日本');
    expect(textOf(dxfBytes('AC1015', 'ANSI_936', [0xd6, 0xd0, 0xce, 0xc4]))).toBe('中文');
    expect(textOf(dxfBytes('AC1015', 'ANSI_949', [0xc7, 0xd1, 0xb1, 0xdb]))).toBe('한글');
    expect(textOf(dxfBytes('AC1015', 'ANSI_950', [0xa4, 0xa4, 0xa4, 0xe5]))).toBe('中文');
    expect(textOf(dxfBytes('AC1015', 'ANSI_1251', [0xc6, 0xe8, 0xe2]))).toBe('Жив');
    expect(textOf(dxfBytes('AC1015', 'ANSI_1250', [0x8a, 0xe8]))).toBe('Šč');
    expect(textOf(dxfBytes('AC1015', 'ANSI_1253', [0xc1, 0xe2]))).toBe('Αβ');
    expect(textOf(dxfBytes('AC1015', 'ANSI_1254', [0xde, 0xf0]))).toBe('Şğ');
    expect(textOf(dxfBytes('AC1015', 'ANSI_1257', [0xc0, 0xe6]))).toBe('Ąę');
    expect(encodingForCodepage('ANSI_1252')).toBe('windows-1252');
    expect(encodingForCodepage('DOS850')).toBe('windows-1252'); // unsupported -> Western
  });

  it('uses UTF-8 for AC1021+, a BOM, or bytes that are valid UTF-8', () => {
    const utf8 = [...new TextEncoder().encode('Motor é 日本')];
    const r2007 = decodeDxfBytes(dxfBytes('AC1021', 'ANSI_1252', utf8));
    expect(r2007.encoding).toBe('utf-8');
    expect(r2007.reason).toBe('version');
    expect(textOf(dxfBytes('AC1021', 'ANSI_1252', utf8))).toBe('Motor é 日本');
    const bom = decodeDxfBytes(dxfBytes('AC1015', 'ANSI_1252', utf8, { bom: true }));
    expect(bom.reason).toBe('bom');
    expect(bom.text.startsWith('0')).toBe(true);
    // Earlier JCad versions wrote UTF-8 into AC1015 files.
    const legacy = decodeDxfBytes(dxfBytes('AC1015', 'ANSI_1252', utf8));
    expect(legacy.reason).toBe('utf8-valid');
    expect(textOf(dxfBytes('AC1015', 'ANSI_1252', utf8))).toBe('Motor é 日本');
    // No code page, not UTF-8: Western default.
    expect(decodeDxfBytes(dxfBytes('AC1009', null, [0xe9])).encoding).toBe('windows-1252');
  });

  it('decodes \\U+XXXX and \\M+nXXXX escapes in TEXT, MTEXT and attributes', () => {
    expect(decodeUnicodeEscapes('Moteur \\U+00E9 \\U+65E5\\U+672C')).toBe('Moteur é 日本');
    expect(decodeUnicodeEscapes('\\M+193FA\\M+1967B')).toBe('日本');
    expect(decodeUnicodeEscapes('\\M+5D6D0')).toBe('中');
    expect(decodeUnicodeEscapes('\\U+D83D\\U+DE00')).toBe('\u{1F600}');
    // Control characters stay escaped so a value can never split a DXF line.
    expect(decodeUnicodeEscapes('a\\U+000Ab')).toBe('a\\U+000Ab');
    expect(textOf(dxfBytes('AC1015', 'ANSI_1252', [...'M\\U+00F6tor'].map((c) => c.charCodeAt(0))))).toBe('Mötor');
    const mtext = `0\nSECTION\n2\nENTITIES\n0\nMTEXT\n8\n0\n10\n0\n20\n0\n40\n0.2\n41\n5\n1\n\\U+00C4rger\\P2 \\U+00D7 K1;\n0\nENDSEC\n0\nEOF\n`;
    const m = readDxf(mtext).entities[0] as MTextEntity;
    expect(m.text).toBe('Ärger\n2 × K1;');
  });

  it('writes AC1015 as ASCII with \\U+ escapes and $DWGCODEPAGE ANSI_1252, and reads it back', () => {
    const doc = new Drawing();
    const t: TextEntity = { id: newId(), type: 'text', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, text: 'Moteur é 日本 Ω', height: 0.2, rotation: 0, align: 'left' };
    doc.addLayer({ name: 'Überwachung', color: 3, visible: true, locked: false, lineWeight: 0.25 });
    doc.addEntities([t, { ...t, id: newId(), layer: 'Überwachung', text: 'Größe' }]);
    const out = writeDxf(doc.snapshot);
    expect(/^[\x00-\x7e]*$/.test(out)).toBe(true);
    expect(out).toContain('$DWGCODEPAGE\r\n3\r\nANSI_1252');
    expect(out).toContain('Moteur \\U+00E9 \\U+65E5\\U+672C \\U+03A9');
    const back = readDxf(decodeDxfBytes(new TextEncoder().encode(out)).text);
    const texts = back.entities.filter((e): e is TextEntity => e.type === 'text').map((e) => e.text);
    expect(texts).toEqual(['Moteur é 日本 Ω', 'Größe']);
    expect(back.layers.some((l) => l.name === 'Überwachung')).toBe(true);
    expect(escapeNonAscii('aé')).toBe('a\\U+00E9');
    expect(encodeDxfText('é', 'AC1027')).toBe('é');
  });

  it('keeps the Node twin used by the Electron main process in step', () => {
    const samples = [
      dxfBytes('AC1015', 'ANSI_932', [0x93, 0xfa, 0x96, 0x7b]),
      dxfBytes('AC1015', 'ANSI_1252', [0xe9]),
      dxfBytes('AC1021', 'ANSI_1252', [...new TextEncoder().encode('é')]),
      dxfBytes('AC1015', 'ANSI_1252', [...new TextEncoder().encode('é')], { bom: true }),
      dxfBytes('AC1009', null, [0xe9]),
      dxfBytes('AC1015', 'ANSI_949', [0xc7, 0xd1]),
      new Uint8Array(readFileSync('fixtures/example_2000.dxf')),
    ];
    for (const b of samples) {
      const a = decodeDxfBytes(b);
      const n = decodeDxfBytesNode(b) as ReturnType<typeof decodeDxfBytes>;
      expect({ text: n.text, encoding: n.encoding, reason: n.reason, acadver: n.acadver, codepage: n.codepage }).toEqual({ text: a.text, encoding: a.encoding, reason: a.reason, acadver: a.acadver, codepage: a.codepage });
    }
  });
});

describe('non-ASCII file names', () => {
  const mainSource = readFileSync('electron/main.cjs', 'utf8');
  const autosaveRe = new RegExp(/function safeAutosaveName[\s\S]*?!\/(.+?)\/\.test\(name\)/.exec(mainSource)![1]!);

  it('autosave names from any title pass the main-process filter', () => {
    for (const title of ['日本語の図面.dxf', 'Schéma moteur 3.dxf', 'Drawing1', 'a b/c\\d.dxf', 'ÆØÅ', '..\\..\\evil.dxf']) {
      const name = autosaveName(title, 12);
      expect(name).toMatch(autosaveRe);
      expect(name).not.toMatch(/[\\/]|\.\./);
    }
    expect(autosaveName('Schéma moteur 3.dxf', 1)).toBe('Sch_ma_moteur_3_1.sv.dxf');
    expect(autosaveName('日本語.dxf', 2)).toBe('Drawing_2.sv.dxf');
  });

  it('the main process reads DXF bytes and compares paths in NFC', () => {
    expect(mainSource).toMatch(/decodeDxf\(await fs\.readFile\(file\)\)/);
    expect(mainSource).not.toMatch(/const text = await fs\.readFile\(file, 'utf8'\);\s*rememberPath\(file\);\s*return \{ path: file, kind: 'dxf'/);
    expect('Jose\u0301.dxf'.normalize('NFC')).toBe('José.dxf'.normalize('NFC'));
    // The reader module URL survives spaces and non-ASCII install folders.
    const href = pathToFileURL('/opt/José/JCad Electrical/resources/app.asar.unpacked/scripts/dwg-reader.mjs').href;
    expect(href).toContain('/Jos%C3%A9/JCad%20Electrical/');
    expect(fileURLToPath(href)).toBe('/opt/José/JCad Electrical/resources/app.asar.unpacked/scripts/dwg-reader.mjs');
  });
});
