export type DataFrameDecision = 'await-header' | 'wrong-transfer' | 'out-of-range' | 'duplicate' | 'accept';

export function decideDataFrameHandling(params: {
  headerReceived: boolean;
  activeTransferId: string | null;
  totalPackets: number | null;
  frameTransferId: string;
  packetIndex: number;
  hasPacket: boolean;
}): DataFrameDecision {
  const { headerReceived, activeTransferId, totalPackets, frameTransferId, packetIndex, hasPacket } = params;
  if (!headerReceived || totalPackets === null || activeTransferId === null) return 'await-header';
  if (frameTransferId !== activeTransferId) return 'wrong-transfer';
  if (packetIndex < 0 || packetIndex >= totalPackets) return 'out-of-range';
  if (hasPacket) return 'duplicate';
  return 'accept';
}

export type TimeoutDecision = 'none' | 'no-end-zero-byte' | 'incomplete-end' | 'no-unique-progress';

export function decideTimeoutHandling(params: {
  now: number;
  headerReceived: boolean;
  totalPackets: number | null;
  receivedPacketsCount: number;
  endSeenAt: number | null;
  lastUniquePacketAt: number;
  endGraceWindowMs: number;
  noUniqueProgressTimeoutMs: number;
}): TimeoutDecision {
  const {
    now,
    headerReceived,
    totalPackets,
    receivedPacketsCount,
    endSeenAt,
    lastUniquePacketAt,
    endGraceWindowMs,
    noUniqueProgressTimeoutMs
  } = params;

  if (!headerReceived || totalPackets === null) return 'none';

  if (totalPackets === 0 && endSeenAt === null && lastUniquePacketAt > 0 && now - lastUniquePacketAt >= noUniqueProgressTimeoutMs) {
    return 'no-end-zero-byte';
  }

  if (receivedPacketsCount < totalPackets) {
    if (endSeenAt !== null && now - endSeenAt >= endGraceWindowMs) return 'incomplete-end';
    if (lastUniquePacketAt > 0 && now - lastUniquePacketAt >= noUniqueProgressTimeoutMs) return 'no-unique-progress';
  }

  return 'none';
}
