export const SCAN_INTERVAL_UNLOCKED_MS = 100;
export const SCAN_INTERVAL_LOCKED_INITIAL_MS = 0;
export const SCAN_INTERVAL_LOCKED_STEADY_MS = 90;

export function selectScanIntervalMs(lockConfirmed: boolean, hasAcceptedUniquePacket: boolean): number {
  if (!lockConfirmed) return SCAN_INTERVAL_UNLOCKED_MS;
  return hasAcceptedUniquePacket ? SCAN_INTERVAL_LOCKED_STEADY_MS : SCAN_INTERVAL_LOCKED_INITIAL_MS;
}

export function shouldProcessParsedFrameWithGeometry(stableGeometry: boolean): { shouldProcess: true; geometryRejected: boolean } {
  return {
    shouldProcess: true,
    geometryRejected: !stableGeometry
  };
}
