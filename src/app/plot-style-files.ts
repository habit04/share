import { readPlotStyleTable } from '../io/plot-styles';

/** Bound a picked file before allocating its contents; the parser also validates actual bytes. */
export const MAX_PLOT_STYLE_FILE_BYTES = 1024 * 1024;
type PickedPlotStyleFile = Pick<File, 'name' | 'size' | 'arrayBuffer'>;

export async function readPlotStyleFile(file: PickedPlotStyleFile) {
  const name = file.name, size = file.size, extension = /\.(ctb|stb)$/i.exec(name)?.[1]?.toLowerCase();
  if (!extension) throw new Error('Choose a CTB or STB plot style table.');
  if (!Number.isSafeInteger(size) || size < 62 || size > MAX_PLOT_STYLE_FILE_BYTES) throw new Error('Plot style tables must be between 62 bytes and 1 MiB.');
  const source = await file.arrayBuffer();
  if (source.byteLength !== size) throw new Error('The plot style file size changed while reading. Choose the file again.');
  const table = await readPlotStyleTable(new Uint8Array(source));
  if (table.kind !== extension) throw new Error('The plot style table header does not match its filename extension.');
  return { name, table };
}
