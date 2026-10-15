import { describe, expect, it } from 'vitest';
import { shippingGpu2dProbeFailure } from '../scripts/shipping-gpu-2d-smoke.mjs';

describe('fixed production GPU probe failure visibility', () => {
  it('reports the actual first native failure without hiding it behind the child exit assertion', () => {
    expect(shippingGpu2dProbeFailure("SHIPPING_PROBE_FAIL Cannot set properties of undefined (setting 'cursor')\n"))
      .toBe("Cannot set properties of undefined (setting 'cursor')");
  });
  it('keeps the existing main timeout visible and retains Unicode reasons', () => {
    expect(shippingGpu2dProbeFailure('log\r\nSHIPPING_PROBE_FAIL timed out\r\n')).toBe('timed out');
    expect(shippingGpu2dProbeFailure('SHIPPING_PROBE_FAIL native font Δ unavailable\n')).toBe('native font Δ unavailable');
  });
  it('does not treat success JSON or unrelated output as a unique fixed main failure', () => {
    for (const value of [null, 4, '', 'SHIPPING_PROBE_OK {"comparisons":[]}\n', 'other failure\n',
      'SHIPPING_PROBE_FAIL \n', 'SHIPPING_PROBE_FAIL first\nSHIPPING_PROBE_FAIL second\n'])
      expect(shippingGpu2dProbeFailure(value)).toBeNull();
  });
  it('bounds console evidence while raw logs remain separate', () => {
    expect(shippingGpu2dProbeFailure('SHIPPING_PROBE_FAIL ' + 'x'.repeat(1001))).toBe('x'.repeat(1000) + ' [truncated]');
    expect(shippingGpu2dProbeFailure('SHIPPING_PROBE_FAIL error\twith\u001bcontrols')).toBe('error with controls');
  });
});
