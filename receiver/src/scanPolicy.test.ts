import { describe, expect, it } from 'vitest';
import {
  SCAN_INTERVAL_LOCKED_INITIAL_MS,
  SCAN_INTERVAL_LOCKED_STEADY_MS,
  SCAN_INTERVAL_UNLOCKED_MS,
  selectScanIntervalMs,
  shouldProcessParsedFrameWithGeometry
} from './scanPolicy';

describe('scanPolicy', () => {
  it('selects scan cadence by lock and post-lock progress state', () => {
    expect(selectScanIntervalMs(false, false)).toBe(SCAN_INTERVAL_UNLOCKED_MS);
    expect(selectScanIntervalMs(true, false)).toBe(SCAN_INTERVAL_LOCKED_INITIAL_MS);
    expect(selectScanIntervalMs(true, true)).toBe(SCAN_INTERVAL_LOCKED_STEADY_MS);
  });

  it('keeps geometry gating advisory after parse success', () => {
    expect(shouldProcessParsedFrameWithGeometry(false)).toEqual({
      shouldProcess: true,
      geometryRejected: true
    });
    expect(shouldProcessParsedFrameWithGeometry(true)).toEqual({
      shouldProcess: true,
      geometryRejected: false
    });
  });
});
