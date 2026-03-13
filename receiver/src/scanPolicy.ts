export const SCAN_INTERVAL_UNLOCKED_MS = 100;
export const SCAN_INTERVAL_LOCKED_MS = 120;

export function selectScanIntervalMs(lockConfirmed: boolean): number {
  return lockConfirmed ? SCAN_INTERVAL_LOCKED_MS : SCAN_INTERVAL_UNLOCKED_MS;
}

export function shouldProcessParsedFrameWithGeometry(stableGeometry: boolean): { shouldProcess: true; geometryRejected: boolean } {
  return {
    shouldProcess: true,
    geometryRejected: !stableGeometry
  };
}
