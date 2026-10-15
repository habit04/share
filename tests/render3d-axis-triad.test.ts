import { describe, expect, it } from 'vitest';
import { AXIS_TRIAD, TRIAD_PAD_PX, TRIAD_PX, type AxisTriadLabel, axisTriadLabels } from '../src/render3d/axis-triad';
import { type Camera3D, type ViewPresetName, VIEW_PRESETS, applyPreset, defaultCamera } from '../src/render3d/camera';
import { v3 } from '../src/model3d/math';

function bounds(label: AxisTriadLabel) {
  const xs = label.segments.flatMap(([x1, , x2]) => [x1, x2]);
  const ys = label.segments.flatMap(([, y1, , y2]) => [y1, y2]);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

function assertReadable(camera: Camera3D, size = TRIAD_PX) {
  const labels = axisTriadLabels(camera, size), scale = Math.min(1, size / TRIAD_PX);
  expect(labels.map(label => label.name)).toEqual(['X', 'Y', 'Z']);
  for (const label of labels) {
    const box = bounds(label);
    expect(box.left).toBeGreaterThanOrEqual(scale - 1e-10);
    expect(box.top).toBeGreaterThanOrEqual(scale - 1e-10);
    expect(box.right).toBeLessThanOrEqual(size - scale + 1e-10);
    expect(box.bottom).toBeLessThanOrEqual(size - scale + 1e-10);
    expect(box.right - box.left).toBeCloseTo(8 * scale, 10);
    expect(box.bottom - box.top).toBeCloseTo(12 * scale, 10);
    // Camera orbit changes placement, never the upright letter strokes themselves.
    const expectedStrokes = {
      X: [[8, 12], [8, -12]],
      Y: [[4, 6], [-4, 6], [0, 6]],
      Z: [[8, 0], [-8, 12], [8, 0]],
    }[label.name];
    expect(label.segments).toHaveLength(expectedStrokes.length);
    label.segments.forEach(([x1, y1, x2, y2], index) => {
      expect(x2 - x1).toBeCloseTo(expectedStrokes[index]![0]! * scale, 10);
      expect(y2 - y1).toBeCloseTo(expectedStrokes[index]![1]! * scale, 10);
    });
    expect(label.color).toEqual(AXIS_TRIAD.find(axis => axis.name === label.name)!.color);
    expect(label.segments.flat().every(Number.isFinite)).toBe(true);
  }
  for (let a = 0; a < labels.length; a++) {
    for (let b = a + 1; b < labels.length; b++) {
      const first = bounds(labels[a]!), second = bounds(labels[b]!);
      const separated = first.right + 2 * scale <= second.left + 1e-10
        || second.right + 2 * scale <= first.left + 1e-10
        || first.bottom + 2 * scale <= second.top + 1e-10
        || second.bottom + 2 * scale <= first.top + 1e-10;
      expect(separated, `Labels ${labels[a]!.name} and ${labels[b]!.name} overlap`).toBe(true);
    }
  }
  expect(axisTriadLabels(camera, size)).toEqual(labels);
  return labels.map(bounds);
}

describe('3D WCS axis labels', () => {
  it('keeps the published axis directions, colours, size and corner inset', () => {
    expect(TRIAD_PX).toBe(76);
    expect(TRIAD_PAD_PX).toBe(10);
    expect(AXIS_TRIAD).toEqual([
      { name: 'X', direction: v3(1, 0, 0), color: [0.95, 0.3, 0.3, 1] },
      { name: 'Y', direction: v3(0, 1, 0), color: [0.35, 0.9, 0.35, 1] },
      { name: 'Z', direction: v3(0, 0, 1), color: [0.4, 0.55, 1, 1] },
    ]);
  });

  it('labels top-view X on the right, Y above, and end-on Z near the origin', () => {
    const [x, y, z] = assertReadable(defaultCamera());
    expect(x!.left).toBeGreaterThan(60);
    expect(y!.bottom).toBeLessThan(22);
    expect(Math.abs((z!.left + z!.right) / 2 - 38)).toBeLessThan(16);
    expect(Math.abs((z!.top + z!.bottom) / 2 - 38)).toBeLessThan(16);
  });

  it('labels front-view X right, Z above, and end-on Y near the origin', () => {
    const [x, y, z] = assertReadable(applyPreset(defaultCamera(), 'front'));
    expect(x!.left).toBeGreaterThan(60);
    expect(z!.bottom).toBeLessThan(22);
    expect(Math.abs((y!.left + y!.right) / 2 - 38)).toBeLessThan(16);
    expect(Math.abs((y!.top + y!.bottom) / 2 - 38)).toBeLessThan(16);
  });

  it('keeps SW isometric labels associated with the right, left and upper axis tips', () => {
    const [x, y, z] = assertReadable(applyPreset(defaultCamera(), 'swIso'));
    expect(x!.left).toBeGreaterThan(50);
    expect(y!.right).toBeLessThan(26);
    expect(z!.bottom).toBeLessThan(22);
  });

  for (const name of Object.keys(VIEW_PRESETS) as ViewPresetName[]) {
    it(`all three labels stay upright, separate and unclipped in ${name}`, () => {
      assertReadable(applyPreset(defaultCamera(), name));
    });
  }

  it('handles coincident projected tips and axes almost end-on without losing a label', () => {
    // X and Y have the same screen-space tip when the camera looks along X-Y.
    for (const yaw of [-Math.PI / 4, 3 * Math.PI / 4, 0, Math.PI / 2]) {
      for (const pitch of [0, 1e-12, -1e-12, Math.PI / 2, -Math.PI / 2]) {
        assertReadable({ ...defaultCamera(), yaw, pitch });
      }
    }
  });

  it('remains readable across a deterministic free-orbit sweep', () => {
    for (let yaw = 0; yaw < 36; yaw++) {
      for (let pitch = 0; pitch <= 18; pitch++) {
        assertReadable({ ...defaultCamera(), yaw: yaw * Math.PI / 18, pitch: -Math.PI / 2 + pitch * Math.PI / 18 });
      }
    }
  });

  it('is independent of target, camera distance, zoom, lens and perspective projection', () => {
    const camera = applyPreset(defaultCamera(), 'seIso'), labels = axisTriadLabels(camera);
    expect(axisTriadLabels({ ...camera, target: v3(1e10, -1e10, 900), distance: 1e-6,
      orthoHeight: 1e9, fovY: Math.PI / 3, projection: 'perspective' })).toEqual(labels);
  });

  it('keeps CSS glyph size at larger sizes and scales down for a smaller triad', () => {
    for (const size of [38, 76, 152]) {
      assertReadable(applyPreset(defaultCamera(), 'swIso'), size);
      assertReadable(applyPreset(defaultCamera(), 'top'), size);
    }
  });
});
