/** Independently authored plot-table schemas; no installed vendor tables are bundled. */
import { deflateSync } from 'node:zlib';

export const PLOT_STYLE_DEFAULTS: Readonly<Record<string, string>> = {
  color: '-1', color_policy: '1', physical_pen_number: '0', virtual_pen_number: '0',
  screen: '100', linepattern_size: '0.5', linetype: '31', adaptive_linetype: 'TRUE',
  lineweight: '0', fill_style: '73', end_style: '4', join_style: '5',
};

export function plotStyleText(options: {
  kind?: 'ctb' | 'stb';
  entries?: Readonly<Record<number, Readonly<Record<string, string>>>>;
  weights?: readonly number[];
  root?: Readonly<Record<string, string>>;
  unknown?: string;
  count?: number;
} = {}): string {
  const kind = options.kind ?? 'ctb', count = options.count ?? (kind === 'ctb' ? 255 : 2);
  const root = {
    description: '"JCad authored table', aci_table_available: kind === 'ctb' ? 'TRUE' : 'FALSE',
    scale_factor: '1.0', apply_factor: 'FALSE', custom_lineweight_display_units: '0', ...options.root,
  };
  const lines = Object.entries(root).map(([key, value]) => `${key}=${value}`);
  if (kind === 'ctb') {
    lines.push('aci_table{');
    for (let index = 0; index < count; index++) lines.push(` ${index}="Color_${index + 1}`);
    lines.push('}');
  }
  lines.push('plot_style{');
  for (let index = 0; index < count; index++) {
    const name = kind === 'ctb' ? `Color_${index + 1}` : index === 0 ? 'Normal' : `Style_${index}`;
    const values = { name: `"${name}`, localized_name: `"${name.replace('_', ' ')}`, description: '"', ...PLOT_STYLE_DEFAULTS, ...options.entries?.[index] };
    lines.push(` ${index}{`, ...Object.entries(values).map(([key, value]) => `  ${key}=${value}`), ' }');
  }
  lines.push('}', 'custom_lineweight_table{', ...(options.weights ?? [0, 0.25, 0.5]).map((weight, index) => ` ${index}=${weight}`), '}');
  if (options.unknown) lines.push(options.unknown);
  return `${lines.join('\n')}\n`;
}

/** The checksum is the Adler32 of the compressed bytes, not the expanded text. */
export function fixtureAdler32(bytes: Uint8Array): number {
  let sum1 = 1, sum2 = 0;
  for (const byte of bytes) { sum1 += byte; sum2 += sum1; sum1 %= 65521; sum2 %= 65521; }
  return (sum2 * 65536 + sum1) >>> 0;
}

export function plotStyleProgram(text: string | Uint8Array, kind: 'ctb' | 'stb' = 'ctb'): Uint8Array {
  const body = typeof text === 'string' ? Buffer.from(text, 'utf8') : Buffer.from(text);
  const compressed = deflateSync(body);
  const header = Buffer.alloc(60);
  header.write(`PIAFILEVERSION_2.0,${kind.toUpperCase()}VER1,compress\r\npmzlibcodec`, 'ascii');
  header.writeUInt32LE(fixtureAdler32(compressed), 48);
  header.writeUInt32LE(body.length, 52);
  header.writeUInt32LE(compressed.length, 56);
  return new Uint8Array(Buffer.concat([header, compressed]));
}
