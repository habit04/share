/** Original binary programs, paired with authored SHP sources in fixtures/shx. */
export interface ShxFixtureRecord { code: number; name?: string; program: readonly number[] }
export const shapeRecords: readonly ShxFixtureRecord[] = [
  { code: 200, name: 'JCADBOX', program: [0x40, 0x44, 0x48, 0x4c, 0] },
  { code: 201, name: 'JCADCIRCLE', program: [10, 4, 0, 0] },
  { code: 202, name: 'JCADBULGE', program: [12, 8, 0, 127, 0] },
  { code: 203, name: 'JCADSUB', program: [5, 7, 200, 6, 2, 8, 6, 0, 0] },
  { code: 204, name: 'JCADXY', program: [8, -3, 4, 9, 3, 1, 2, -3, 0, 0, 0] },
  { code: 205, name: 'JCADVECTOR', program: [0x13, 0x12, 0x11, 0x1f, 0x1e, 0] },
];
export const fontRecords: readonly ShxFixtureRecord[] = [
  { code: 0, name: 'JCad Test Font', program: [10, 2, 2, 0, 0, 0] },
  { code: 32, program: [2, 8, 6, 0, 0] },
  { code: 65, program: [8, 4, 10, 8, 4, -10, 2, 8, -6, 4, 1, 8, 4, 0, 2, 8, 4, -4, 0] },
  { code: 67, program: [2, 8, 5, 5, 1, 10, 5, 0, 2, 8, 5, -5, 0] },
  { code: 68, program: [7, 0, 65, 2, 8, 2, 0, 0] },
  { code: 69, program: [3, 2, 7, 0, 65, 4, 2, 2, 8, 2, 0, 0] },
  { code: 70, program: [14, 8, 0, 20, 8, 6, 0, 2, 8, 2, 0, 0] },
];

export function shxFixture(format: 'shapes' | 'unifont' = 'unifont', records = format === 'shapes' ? shapeRecords : fontRecords): Uint8Array {
  const signature = Buffer.from(`AutoCAD-86 ${format} 1.0\r\n\x1a`, 'ascii');
  const payloads = records.map(({ name = '', program }) => Buffer.concat([Buffer.from(`${name}\0`, 'latin1'), Buffer.from(program.map((value) => value & 255))]));
  if (format === 'unifont') {
    const count = Buffer.alloc(2); count.writeUInt16LE(records.length);
    return Buffer.concat([signature, count, ...records.flatMap(({ code }, i) => {
      const h = Buffer.alloc(4); h.writeUInt16LE(code); h.writeUInt16LE(payloads[i]!.length, 2); return [h, payloads[i]!];
    })]);
  }
  const header = Buffer.alloc(6); header.writeUInt16LE(Math.min(...records.map((record) => record.code))); header.writeUInt16LE(Math.max(...records.map((record) => record.code)), 2); header.writeUInt16LE(records.length, 4);
  const index = records.map(({ code }, i) => { const h = Buffer.alloc(4); h.writeUInt16LE(code); h.writeUInt16LE(payloads[i]!.length, 2); return h; });
  return Buffer.concat([signature, header, ...index, ...payloads, Buffer.from('EOF', 'ascii')]);
}
