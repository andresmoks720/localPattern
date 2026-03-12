import { FRAME_TYPE_HEADER, MAGIC_BYTES, PROTOCOL_ERROR_CODES, ProtocolError, parseFrame, type ReceiverMachine, type ReceiverSnapshot, type TransferFrame } from '@qr-data-bridge/protocol';

const DEFAULT_SCANNER_DEDUPE_WINDOW_MS = 4000;
const DEFAULT_MAX_PENDING_INGESTIONS = 64;

export interface ReceiverIngestDiagnostics {
  totalPayloadsSeen: number;
  nonProtocolPayloads: number;
  duplicateScannerPayloads: number;
  malformedPayloads: number;
  badPacketCrcFrames: number;
  foreignTransferFrames: number;
  acceptedFrames: number;
  finalizeDurationMs: number | null;
  droppedQueuedPayloads: number;
}

export type ReceiverIngestEvent =
  | { type: 'frameAccepted'; frame: TransferFrame; snapshot: ReceiverSnapshot }
  | { type: 'decodeError'; message: string }
  | { type: 'duplicateScannerPayload' }
  | { type: 'foreignFrameIgnored' }
  | { type: 'badPacketCrcIgnored' }
  | { type: 'completed'; durationMs: number };

interface PendingIngestion {
  rawPayload: Uint8Array;
  now: number;
  dedupeKey: string;
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
  let hash = 2166136261;
  for (let i = 0; i < rawPayload.length; i += 1) {
    hash ^= rawPayload[i];
    hash = Math.imul(hash, 16777619);
  }
  return `${rawPayload.length}:${hash >>> 0}`;
}

export class ReceiverIngestService {
  private readonly recentPayloads = new Map<string, number>();

  private readonly recentPayloadOrder: ScannerKeyEntry[] = [];

  private firstAcceptedAt: number | null = null;

  private diagnosticsValue: ReceiverIngestDiagnostics = {
    totalPayloadsSeen: 0,
    nonProtocolPayloads: 0,
    duplicateScannerPayloads: 0,
    malformedPayloads: 0,
    badPacketCrcFrames: 0,
    foreignTransferFrames: 0,
    acceptedFrames: 0,
    finalizeDurationMs: null,
    droppedQueuedPayloads: 0
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
    this.ingestionChain = Promise.resolve(null);
    this.diagnosticsValue = {
      totalPayloadsSeen: 0,
      nonProtocolPayloads: 0,
      duplicateScannerPayloads: 0,
      malformedPayloads: 0,
      badPacketCrcFrames: 0,
      foreignTransferFrames: 0,
      acceptedFrames: 0,
      finalizeDurationMs: null,
      droppedQueuedPayloads: 0
    };
  }

  public getDiagnostics(): ReceiverIngestDiagnostics {
    return { ...this.diagnosticsValue };
  }

  public enqueue(rawPayload: Uint8Array, now: number): Promise<ReceiverSnapshot | null> {
    const dedupeKey = scannerPayloadKey(rawPayload);
    const windowMs = this.deps.scannerDedupeWindowMs ?? DEFAULT_SCANNER_DEDUPE_WINDOW_MS;
    let allowForHeaderLockDuplicates = false;
    try {
      const frame = parseFrame(rawPayload);
      allowForHeaderLockDuplicates = frame.frameType === FRAME_TYPE_HEADER && !this.deps.machine.snapshot.lockConfirmed;
    } catch {
      allowForHeaderLockDuplicates = false;
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
      const removed = this.pendingIngestions.shift();
      if (removed) {
        this.pendingKeyToIndex.delete(removed.dedupeKey);
      }
      this.reindexPendingKeysFrom(0);
      this.diagnosticsValue.droppedQueuedPayloads += 1;
    }
    this.pendingIngestions.push({ rawPayload, now, dedupeKey });
    this.pendingKeyToIndex.set(dedupeKey, this.pendingIngestions.length - 1);

    this.ingestionChain = this.ingestionChain.then(async () => {
      const next = this.pendingIngestions.shift();
      if (!next) return null;
      this.pendingKeyToIndex.delete(next.dedupeKey);
      this.reindexPendingKeysFrom(0);
      return this.ingestNow(next.rawPayload, next.now);
    });
    return this.ingestionChain;
  }

  public ingest(rawPayload: Uint8Array, now: number): ReceiverSnapshot | null {
    return this.ingestNow(rawPayload, now);
  }

  private ingestNow(rawPayload: Uint8Array, now: number): ReceiverSnapshot | null {
    this.diagnosticsValue.totalPayloadsSeen += 1;

    if (!this.isProtocolPayload(rawPayload)) {
      this.diagnosticsValue.nonProtocolPayloads += 1;
      return null;
    }

    this.pruneDedupeWindow(now);
    let duplicateScannerPayload = false;
    if (this.deps.scannerDedupeEnabled ?? true) {
      const dedupeKey = scannerPayloadKey(rawPayload);
      const seenAt = this.recentPayloads.get(dedupeKey);
      if (seenAt !== undefined && now - seenAt <= (this.deps.scannerDedupeWindowMs ?? DEFAULT_SCANNER_DEDUPE_WINDOW_MS)) {
        duplicateScannerPayload = true;
      } else {
        this.recentPayloads.set(dedupeKey, now);
        this.recentPayloadOrder.push({ key: dedupeKey, seenAt: now });
      }
    }

    try {
      const frame = parseFrame(rawPayload);
      const before = this.deps.machine.snapshot;

      if (duplicateScannerPayload) {
        const allowForHeaderLock = frame.frameType === FRAME_TYPE_HEADER && !before.lockConfirmed;
        if (!allowForHeaderLock) {
          this.diagnosticsValue.duplicateScannerPayloads += 1;
          this.deps.onEvent?.({ type: 'duplicateScannerPayload' });
          return null;
        }
      }
      const snapshot = this.deps.machine.applyFrame(frame, now);

      if (before.transferId && transferIdToHex(frame.transferId) !== before.transferId) {
        this.diagnosticsValue.foreignTransferFrames += 1;
        this.deps.onEvent?.({ type: 'foreignFrameIgnored' });
      }

      this.diagnosticsValue.acceptedFrames += 1;
      this.firstAcceptedAt = this.firstAcceptedAt ?? now;
      this.deps.onEvent?.({ type: 'frameAccepted', frame, snapshot });

      if (snapshot.state === 'SUCCESS' && this.firstAcceptedAt !== null && this.diagnosticsValue.finalizeDurationMs === null) {
        this.diagnosticsValue.finalizeDurationMs = now - this.firstAcceptedAt;
        this.deps.onEvent?.({ type: 'completed', durationMs: this.diagnosticsValue.finalizeDurationMs });
      }

      return snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown packet decode error.';
      if (error instanceof ProtocolError && error.code === PROTOCOL_ERROR_CODES.PACKET_CRC_MISMATCH) {
        this.diagnosticsValue.badPacketCrcFrames += 1;
        this.deps.onEvent?.({ type: 'badPacketCrcIgnored' });
      } else {
        this.diagnosticsValue.malformedPayloads += 1;
      }
      this.deps.onEvent?.({ type: 'decodeError', message });
      return null;
    }
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
}
