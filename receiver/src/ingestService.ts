import { FRAME_TYPE_DATA, FRAME_TYPE_HEADER, MAGIC_BYTES, PROTOCOL_ERROR_CODES, ProtocolError, parseFrame, type ReceiverMachine, type ReceiverSnapshot, type TransferFrame } from '@qr-data-bridge/protocol';

const DEFAULT_SCANNER_DEDUPE_WINDOW_MS = 250;
const DEFAULT_MAX_PENDING_INGESTIONS = 64;

export interface ReceiverIngestDiagnostics {
  totalPayloadsSeen: number;
  nonProtocolPayloads: number;
  duplicateScannerPayloads: number;
  malformedPayloads: number;
  protocolErrorFrames: number;
  badPacketCrcFrames: number;
  foreignTransferFrames: number;
  acceptedFrames: number;
  acceptedUniquePackets: number;
  duplicateProtocolPackets: number;
  finalizeDurationMs: number | null;
  droppedQueuedPayloads: number;
  queueDepthMax: number;
  queueWaitAvgMs: number;
  queueWaitP95Ms: number;
  ingestDurationAvgMs: number;
  ingestDurationP95Ms: number;
  overflowDropsDuplicate: number;
  overflowDropsNonDuplicate: number;
}

export type ReceiverIngestEvent =
  | { type: 'frameAccepted'; frame: TransferFrame; snapshot: ReceiverSnapshot; tuple: FrameTuple }
  | { type: 'frameDropped'; reason: 'duplicateScannerPayload' | 'foreignTransferFrame' | 'replayedSequence' | 'queueOverflow'; tuple: FrameTuple | null }
  | { type: 'decodeError'; message: string }
  | { type: 'duplicateScannerPayload' }
  | { type: 'foreignFrameIgnored' }
  | { type: 'badPacketCrcIgnored' }
  | { type: 'completed'; durationMs: number };

interface FrameTuple {
  sessionId: string;
  streamId: 'HEADER' | 'DATA' | 'END';
  seq: number;
}

interface PendingIngestion {
  rawPayload: Uint8Array;
  now: number;
  enqueuedAt: number;
  dedupeKey: string;
  parsedFrame: TransferFrame | null;
}

interface ScannerKeyEntry {
  key: string;
  seenAt: number;
}

function transferIdToHex(transferId: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < transferId.length; i += 1) {
    hex += transferId[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function scannerPayloadKey(rawPayload: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < rawPayload.length; i += 1) {
    hex += rawPayload[i].toString(16).padStart(2, '0');
  }
  return `${rawPayload.length}:${hex}`;
}

export class ReceiverIngestService {
  private readonly recentPayloads = new Map<string, number>();

  private readonly recentPayloadOrder: ScannerKeyEntry[] = [];

  private firstAcceptedAt: number | null = null;

  private readonly queueWaitSamples: number[] = [];

  private readonly ingestDurationSamples: number[] = [];

  private queueWaitSumMs = 0;

  private ingestDurationSumMs = 0;

  private diagnosticsValue: ReceiverIngestDiagnostics = {
    totalPayloadsSeen: 0,
    nonProtocolPayloads: 0,
    duplicateScannerPayloads: 0,
    malformedPayloads: 0,
    protocolErrorFrames: 0,
    badPacketCrcFrames: 0,
    foreignTransferFrames: 0,
    acceptedFrames: 0,
    acceptedUniquePackets: 0,
    duplicateProtocolPackets: 0,
    finalizeDurationMs: null,
    droppedQueuedPayloads: 0,
    queueDepthMax: 0,
    queueWaitAvgMs: 0,
    queueWaitP95Ms: 0,
    ingestDurationAvgMs: 0,
    ingestDurationP95Ms: 0,
    overflowDropsDuplicate: 0,
    overflowDropsNonDuplicate: 0
  };

  private ingestionChain: Promise<ReceiverSnapshot | null> = Promise.resolve(null);

  private readonly pendingIngestions: PendingIngestion[] = [];

  private readonly pendingKeyToIndex = new Map<string, number>();

  constructor(
    private readonly deps: {
      machine: ReceiverMachine;
      onEvent?: (event: ReceiverIngestEvent) => void;
      scannerDedupeEnabled?: boolean;
      scannerDedupeWindowMs?: number;
      maxPendingIngestions?: number;
    }
  ) {}

  public reset(): void {
    this.recentPayloads.clear();
    this.recentPayloadOrder.length = 0;
    this.firstAcceptedAt = null;
    this.pendingIngestions.length = 0;
    this.pendingKeyToIndex.clear();
    this.queueWaitSamples.length = 0;
    this.ingestDurationSamples.length = 0;
    this.queueWaitSumMs = 0;
    this.ingestDurationSumMs = 0;
    this.ingestionChain = Promise.resolve(null);
    this.diagnosticsValue = {
      totalPayloadsSeen: 0,
      nonProtocolPayloads: 0,
      duplicateScannerPayloads: 0,
      malformedPayloads: 0,
      protocolErrorFrames: 0,
      badPacketCrcFrames: 0,
      foreignTransferFrames: 0,
      acceptedFrames: 0,
      acceptedUniquePackets: 0,
      duplicateProtocolPackets: 0,
      finalizeDurationMs: null,
      droppedQueuedPayloads: 0,
      queueDepthMax: 0,
      queueWaitAvgMs: 0,
      queueWaitP95Ms: 0,
      ingestDurationAvgMs: 0,
      ingestDurationP95Ms: 0,
      overflowDropsDuplicate: 0,
      overflowDropsNonDuplicate: 0
    };
  }

  public getDiagnostics(): ReceiverIngestDiagnostics {
    return { ...this.diagnosticsValue };
  }

  public enqueue(rawPayload: Uint8Array, now: number, parsedFrame: TransferFrame | null = null): Promise<ReceiverSnapshot | null> {
    const dedupeKey = scannerPayloadKey(rawPayload);
    const windowMs = this.deps.scannerDedupeWindowMs ?? DEFAULT_SCANNER_DEDUPE_WINDOW_MS;
    let allowForHeaderLockDuplicates = false;
    if (parsedFrame) {
      allowForHeaderLockDuplicates = parsedFrame.frameType === FRAME_TYPE_HEADER && !this.deps.machine.snapshot.lockConfirmed;
    } else {
      try {
        const frame = parseFrame(rawPayload);
        parsedFrame = frame;
        allowForHeaderLockDuplicates = frame.frameType === FRAME_TYPE_HEADER && !this.deps.machine.snapshot.lockConfirmed;
      } catch {
        allowForHeaderLockDuplicates = false;
      }
    }

    if (this.deps.scannerDedupeEnabled ?? true) {
      this.pruneDedupeWindow(now);
      const seenAt = this.recentPayloads.get(dedupeKey);
      if (seenAt !== undefined && now - seenAt <= windowMs) {
        if (!allowForHeaderLockDuplicates) {
          this.diagnosticsValue.duplicateScannerPayloads += 1;
          this.deps.onEvent?.({ type: 'duplicateScannerPayload' });
          return Promise.resolve(null);
        }
      }
    }

    const existingIndex = this.pendingKeyToIndex.get(dedupeKey);
    if (existingIndex !== undefined && !allowForHeaderLockDuplicates) {
      this.pendingIngestions.splice(existingIndex, 1);
      this.reindexPendingKeysFrom(existingIndex);
    }

    const maxPendingIngestions = this.deps.maxPendingIngestions ?? DEFAULT_MAX_PENDING_INGESTIONS;
    if (this.pendingIngestions.length >= maxPendingIngestions) {
      const dropIndex = this.findQueueOverflowDropIndex(dedupeKey);
      const [removed] = this.pendingIngestions.splice(dropIndex, 1);
      if (removed) {
        this.pendingKeyToIndex.delete(removed.dedupeKey);
        if (removed.dedupeKey === dedupeKey) {
          this.diagnosticsValue.overflowDropsDuplicate += 1;
        } else {
          this.diagnosticsValue.overflowDropsNonDuplicate += 1;
        }
        this.deps.onEvent?.({ type: 'frameDropped', reason: 'queueOverflow', tuple: null });
      }
      this.reindexPendingKeysFrom(dropIndex);
      this.diagnosticsValue.droppedQueuedPayloads += 1;
    }
    this.pendingIngestions.push({ rawPayload, now, enqueuedAt: Date.now(), dedupeKey, parsedFrame });
    this.pendingKeyToIndex.set(dedupeKey, this.pendingIngestions.length - 1);
    this.diagnosticsValue.queueDepthMax = Math.max(this.diagnosticsValue.queueDepthMax, this.pendingIngestions.length);

    this.ingestionChain = this.ingestionChain.then(async () => {
      const next = this.pendingIngestions.shift();
      if (!next) return null;
      this.pendingKeyToIndex.delete(next.dedupeKey);
      this.reindexPendingKeysFrom(0);
      const queueWaitMs = Math.max(0, Date.now() - next.enqueuedAt);
      this.recordQueueWait(queueWaitMs);
      const ingestStartedAt = Date.now();
      const snapshot = this.ingestNow(next.rawPayload, next.now, next.parsedFrame);
      this.recordIngestDuration(Math.max(0, Date.now() - ingestStartedAt));
      return snapshot;
    });
    return this.ingestionChain;
  }

  public ingest(rawPayload: Uint8Array, now: number): ReceiverSnapshot | null {
    const startedAt = Date.now();
    const snapshot = this.ingestNow(rawPayload, now);
    this.recordIngestDuration(Math.max(0, Date.now() - startedAt));
    return snapshot;
  }

  private ingestNow(rawPayload: Uint8Array, now: number, parsedFrame: TransferFrame | null = null): ReceiverSnapshot | null {
    this.diagnosticsValue.totalPayloadsSeen += 1;

    if (!this.isProtocolPayload(rawPayload)) {
      this.diagnosticsValue.nonProtocolPayloads += 1;
      return null;
    }

    this.pruneDedupeWindow(now);
    const dedupeKey = scannerPayloadKey(rawPayload);
    let duplicateScannerPayload = false;
    if (this.deps.scannerDedupeEnabled ?? true) {
      const seenAt = this.recentPayloads.get(dedupeKey);
      if (seenAt !== undefined && now - seenAt <= (this.deps.scannerDedupeWindowMs ?? DEFAULT_SCANNER_DEDUPE_WINDOW_MS)) {
        duplicateScannerPayload = true;
      }
    }

    try {
      const frame = parsedFrame ?? parseFrame(rawPayload);
      const before = this.deps.machine.snapshot;
      const tuple = frameTuple(frame);

      if ((this.deps.scannerDedupeEnabled ?? true) && !duplicateScannerPayload) {
        this.recentPayloads.set(dedupeKey, now);
        this.recentPayloadOrder.push({ key: dedupeKey, seenAt: now });
      }

      if (duplicateScannerPayload) {
        const allowForHeaderLock = frame.frameType === FRAME_TYPE_HEADER && !before.lockConfirmed;
        this.deps.machine.noteLockedTransferActivity(frame, now);
        if (!allowForHeaderLock) {
          this.diagnosticsValue.duplicateScannerPayloads += 1;
          this.deps.onEvent?.({ type: 'duplicateScannerPayload' });
          this.deps.onEvent?.({ type: 'frameDropped', reason: 'duplicateScannerPayload', tuple });
          return null;
        }
      }

      if (before.lockConfirmed && before.transferId && tuple.sessionId !== before.transferId) {
        this.diagnosticsValue.foreignTransferFrames += 1;
        this.deps.onEvent?.({ type: 'foreignFrameIgnored' });
        this.deps.onEvent?.({ type: 'frameDropped', reason: 'foreignTransferFrame', tuple });
        return null;
      }

      const snapshot = this.deps.machine.applyFrame(frame, now);

      this.diagnosticsValue.acceptedFrames += 1;
      if (frame.frameType === FRAME_TYPE_DATA) {
        if (snapshot.receivedCount > before.receivedCount) {
          this.diagnosticsValue.acceptedUniquePackets += 1;
        } else if (before.lockConfirmed) {
          this.diagnosticsValue.duplicateProtocolPackets += 1;
        }
      }
      this.firstAcceptedAt = this.firstAcceptedAt ?? now;
      this.deps.onEvent?.({ type: 'frameAccepted', frame, snapshot, tuple });

      if (snapshot.state === 'SUCCESS' && this.firstAcceptedAt !== null && this.diagnosticsValue.finalizeDurationMs === null) {
        this.diagnosticsValue.finalizeDurationMs = now - this.firstAcceptedAt;
        this.deps.onEvent?.({ type: 'completed', durationMs: this.diagnosticsValue.finalizeDurationMs });
      }

      return snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown packet decode error.';
      if (error instanceof ProtocolError) {
        if (error.code === PROTOCOL_ERROR_CODES.PACKET_CRC_MISMATCH) {
          this.diagnosticsValue.badPacketCrcFrames += 1;
          this.deps.onEvent?.({ type: 'badPacketCrcIgnored' });
        } else {
          this.diagnosticsValue.protocolErrorFrames += 1;
        }
      } else {
        this.diagnosticsValue.malformedPayloads += 1;
      }
      this.deps.onEvent?.({ type: 'decodeError', message });
      return null;
    }
  }


  private recordQueueWait(waitMs: number): void {
    this.queueWaitSamples.push(waitMs);
    this.queueWaitSumMs += waitMs;
    this.diagnosticsValue.queueWaitAvgMs = this.queueWaitSumMs / this.queueWaitSamples.length;
    this.diagnosticsValue.queueWaitP95Ms = percentile(this.queueWaitSamples, 0.95);
  }

  private recordIngestDuration(durationMs: number): void {
    this.ingestDurationSamples.push(durationMs);
    this.ingestDurationSumMs += durationMs;
    this.diagnosticsValue.ingestDurationAvgMs = this.ingestDurationSumMs / this.ingestDurationSamples.length;
    this.diagnosticsValue.ingestDurationP95Ms = percentile(this.ingestDurationSamples, 0.95);
  }

  private isProtocolPayload(rawPayload: Uint8Array): boolean {
    return rawPayload.length > 5 && MAGIC_BYTES.every((byte, index) => rawPayload[index] === byte);
  }

  private pruneDedupeWindow(now: number): void {
    const windowMs = this.deps.scannerDedupeWindowMs ?? DEFAULT_SCANNER_DEDUPE_WINDOW_MS;
    while (this.recentPayloadOrder.length > 0) {
      const first = this.recentPayloadOrder[0];
      if (now - first.seenAt <= windowMs) break;
      this.recentPayloadOrder.shift();
      const currentSeenAt = this.recentPayloads.get(first.key);
      if (currentSeenAt === first.seenAt) {
        this.recentPayloads.delete(first.key);
      }
    }
  }

  private reindexPendingKeysFrom(startIndex: number): void {
    for (let i = startIndex; i < this.pendingIngestions.length; i += 1) {
      this.pendingKeyToIndex.set(this.pendingIngestions[i].dedupeKey, i);
    }
  }

  private findQueueOverflowDropIndex(incomingKey: string): number {
    if (this.pendingIngestions.length === 0) return 0;

    const keyCounts = new Map<string, number>();
    for (const pending of this.pendingIngestions) {
      keyCounts.set(pending.dedupeKey, (keyCounts.get(pending.dedupeKey) ?? 0) + 1);
    }
    keyCounts.set(incomingKey, (keyCounts.get(incomingKey) ?? 0) + 1);

    for (let i = 0; i < this.pendingIngestions.length; i += 1) {
      const key = this.pendingIngestions[i].dedupeKey;
      if ((keyCounts.get(key) ?? 0) > 1) {
        return i;
      }
    }

    return 0;
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index];
}

function frameTuple(frame: TransferFrame): FrameTuple {
  if (frame.frameType === FRAME_TYPE_HEADER) {
    return { sessionId: transferIdToHex(frame.transferId), streamId: 'HEADER', seq: 0 };
  }
  if (frame.frameType === FRAME_TYPE_DATA) {
    return { sessionId: transferIdToHex(frame.transferId), streamId: 'DATA', seq: frame.packetIndex };
  }
  return { sessionId: transferIdToHex(frame.transferId), streamId: 'END', seq: 0 };
}
