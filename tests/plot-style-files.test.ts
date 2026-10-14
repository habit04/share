import { describe, expect, it, vi } from 'vitest';
import { readPlotStyleFile, MAX_PLOT_STYLE_FILE_BYTES } from '../src/app/plot-style-files';
import { plotStyleProgram, plotStyleText } from './helpers/plot-style-fixture';

function file(kind: 'ctb' | 'stb' = 'ctb') {
  const bytes = new Uint8Array(plotStyleProgram(plotStyleText({ kind }), kind));
  return { name: `private.${kind}`, size: bytes.byteLength, arrayBuffer: vi.fn(async () => bytes.buffer) };
}
describe('picked plot style files', () => {
  it.each(['ctb', 'stb'] as const)('loads a captured %s file as immutable plot-time data', async (kind) => {
    const picked = file(kind), result = await readPlotStyleFile(picked);
    expect(result.name).toBe(picked.name); expect(result.table.kind).toBe(kind);
    expect(Object.isFrozen(result.table)).toBe(true); expect(picked.arrayBuffer).toHaveBeenCalledOnce();
  });
  it('rejects oversized, invalid-sized and other-format files before reading their contents', async () => {
    for (const extra of [{ size: MAX_PLOT_STYLE_FILE_BYTES + 1 }, { size: NaN }, { size: 61 }, { name: 'drawing.dxf' }]) {
      const picked = { ...file(), ...extra };
      await expect(readPlotStyleFile(picked)).rejects.toThrow(); expect(picked.arrayBuffer).not.toHaveBeenCalled();
    }
  });
  it('refuses mismatched actual length and kind without returning a partial table', async () => {
    await expect(readPlotStyleFile({ ...file(), size: file().size + 1 })).rejects.toThrow('size changed');
    await expect(readPlotStyleFile({ ...file('stb'), name: 'mislabelled.ctb' })).rejects.toThrow('header');
  });
  it('captures the display name before the asynchronous read and surfaces read failures', async () => {
    const picked = file(), pending = readPlotStyleFile(picked); picked.name = 'later.stb';
    expect((await pending).name).toBe('private.ctb');
    await expect(readPlotStyleFile({ ...file(), arrayBuffer: async () => { throw new Error('private read failure'); } })).rejects.toThrow('private read failure');
  });
});
