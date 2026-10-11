/** MTEXT columns under transforms, ported from PR #2 (codex/electrical-review-fixes 2f89b0e). */
import { describe, expect, it } from 'vitest';
import { blockTransform, scaleEntityBy, type MTextEntity } from '../src/core/entities';

const text: MTextEntity = {
  id: 'columns', type: 'mtext', layer: '0', color: 'ByLayer',
  position: { x: 1, y: 2 }, text: 'Left\nRight', raw: 'Left\\NRight',
  height: 2, width: 24, rotation: 0, attachment: 1, lineSpacing: 1,
  columns: { type: 1, count: 2, width: 10, gutter: 4, autoHeight: false, reversed: false, heights: [6, 8] },
};

describe('MTEXT column transforms', () => {
  it('keeps column dimensions proportional when the drawing scales', () => {
    const result = scaleEntityBy(text, { x: 0, y: 0 }, 3) as MTextEntity;
    expect(result.columns).toEqual({ ...text.columns, width: 30, gutter: 12, heights: [18, 24] });
    expect(result.position).toEqual({ x: 3, y: 6 });
    expect(text.columns?.heights).toEqual([6, 8]);
  });

  it('scales column spacing with text inside a transformed block', () => {
    const result = blockTransform(text, (point) => ({ x: point.x * 2, y: point.y * 2 }), 0, 2, 2, false) as MTextEntity;
    expect(result.columns?.width).toBe(20);
    expect(result.columns?.gutter).toBe(8);
    expect(result.columns?.heights).toEqual([12, 16]);
  });
});
