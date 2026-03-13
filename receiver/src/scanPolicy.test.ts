import { describe, expect, it } from 'vitest';
import {
  SCAN_INTERVAL_LOCKED_MS,
  SCAN_INTERVAL_UNLOCKED_MS,
  selectScanIntervalMs,
  shouldProcessParsedFrameWithGeometry
} from './scanPolicy';

describe('scanPolicy', () => {
  it('selects scan cadence by lock state', () => {
    expect(selectScanIntervalMs(false)).toBe(SCAN_INTERVAL_UNLOCKED_MS);
    expect(selectScanIntervalMs(true)).toBe(SCAN_INTERVAL_LOCKED_MS);
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
