import { MAGIC_BYTES, PROTOCOL_ERROR_CODES, ProtocolError, parseFrame, type ReceiverMachine, type ReceiverSnapshot, type TransferFrame } from '@qr-data-bridge/protocol';

export interface ReceiverIngestDiagnostics {
  totalPayloadsSeen: number;
  nonProtocolPayloads: number;
  duplicateScannerPayloads: number;
  malformedPayloads: number;
  badPacketCrcFrames: number;
  foreignTransferFrames: number;
  acceptedFrames: number;
  finalizeDurationMs: number | null;
}

export type ReceiverIngestEvent =
  | { type: 'frameAccepted'; frame: TransferFrame; snapshot: ReceiverSnapshot }
  | { type: 'decodeError'; message: string }
  | { type: 'duplicateScannerPayload' }
  | { type: 'foreignFrameIgnored' }
  | { type: 'badPacketCrcIgnored' }
  | { type: 'completed'; durationMs: number };

export class ReceiverIngestService {
  private readonly recentPayloads = new Map<string, number>();

  private firstAcceptedAt: number | null = null;

  private diagnosticsValue: ReceiverIngestDiagnostics = {
    totalPayloadsSeen: 0,
    nonProtocolPayloads: 0,
    duplicateScannerPayloads: 0,
    malformedPayloads: 0,
    badPacketCrcFrames: 0,
    foreignTransferFrames: 0,
    acceptedFrames: 0,
    finalizeDurationMs: null
  };

  private ingestionChain: Promise<ReceiverSnapshot | null> = Promise.resolve(null);

  private readonly pendingIngestions: Array<{ rawPayload: Uint8Array; now: number }> = [];
  constructor(
    private readonly deps: {
      machine: ReceiverMachine;
      onEvent?: (event: ReceiverIngestEvent) => void;
      scannerDedupeEnabled?: boolean;
      scannerDedupeWindowMs?: number;
    }
  ) {}

  public reset(): void {
    this.recentPayloads.clear();
    this.firstAcceptedAt = null;
    this.pendingIngestions.length = 0;
    this.ingestionChain = Promise.resolve(null);
    this.diagnosticsValue = {
      totalPayloadsSeen: 0,
      nonProtocolPayloads: 0,
      duplicateScannerPayloads: 0,
      malformedPayloads: 0,
      badPacketCrcFrames: 0,
      foreignTransferFrames: 0,
      acceptedFrames: 0,
      finalizeDurationMs: null
    };
  }

  public getDiagnostics(): ReceiverIngestDiagnostics {
    return { ...this.diagnosticsValue };
  }

  public enqueue(rawPayload: Uint8Array, now: number): Promise<ReceiverSnapshot | null> {
    this.pendingIngestions.push({ rawPayload, now });
    this.ingestionChain = this.ingestionChain.then(async () => {
      const next = this.pendingIngestions.shift();
      if (!next) return null;
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
    const dedupeKey = this.toPayloadKey(rawPayload);
    if (this.deps.scannerDedupeEnabled ?? true) {
      const seenAt = this.recentPayloads.get(dedupeKey);
      if (seenAt !== undefined && now - seenAt <= (this.deps.scannerDedupeWindowMs ?? 4000)) {
        this.diagnosticsValue.duplicateScannerPayloads += 1;
        this.deps.onEvent?.({ type: 'duplicateScannerPayload' });
        return null;
      }
      this.recentPayloads.set(dedupeKey, now);
    }

    try {
      const frame = parseFrame(rawPayload);
      const before = this.deps.machine.snapshot;
      const snapshot = this.deps.machine.applyFrame(frame, now);

      if (
        before.transferId
        && Array.from(frame.transferId).map((value) => value.toString(16).padStart(2, '0')).join('') !== before.transferId
      ) {
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

  private toPayloadKey(rawPayload: Uint8Array): string {
    return Array.from(rawPayload).map((value) => value.toString(16).padStart(2, '0')).join('');
  }

  private pruneDedupeWindow(now: number): void {
    const windowMs = this.deps.scannerDedupeWindowMs ?? 4000;
    for (const [payload, seenAt] of this.recentPayloads) {
      if (now - seenAt > windowMs) {
        this.recentPayloads.delete(payload);
      }
    }
  }
}
