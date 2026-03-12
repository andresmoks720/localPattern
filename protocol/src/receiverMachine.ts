import { calculateCRC32 } from './crc32';
import { PROTOCOL_ERROR_CODES, ProtocolError } from './types';
import { FRAME_TYPE_DATA, FRAME_TYPE_END, FRAME_TYPE_HEADER, type TransferDataFrame, type TransferEndFrame, type TransferFrame, type TransferHeaderFrame } from './types';

export const RECEIVER_TIMEOUTS = {
  END_GRACE_MS: 2000,
  NO_UNIQUE_PROGRESS_TIMEOUT_MS: 15000,
  LOCKED_TRANSFER_ACTIVITY_GRACE_MS: 2000
} as const;

export const RECEIVER_LOCK_CONFIRMATION = {
  REQUIRED_HEADERS: 3,
  WINDOW_MS: 1500
} as const;

export type ReceiverState = 'IDLE' | 'SCANNING' | 'RECEIVING' | 'VERIFYING' | 'SUCCESS' | 'ERROR';

export const RECEIVER_STATE_TRANSITIONS: Record<ReceiverState, ReceiverState[]> = {
  IDLE: ['IDLE', 'SCANNING'],
  SCANNING: ['SCANNING', 'RECEIVING', 'ERROR', 'IDLE'],
  RECEIVING: ['RECEIVING', 'VERIFYING', 'ERROR', 'IDLE'],
  VERIFYING: ['VERIFYING', 'SUCCESS', 'ERROR', 'IDLE'],
  SUCCESS: ['SUCCESS', 'IDLE'],
  ERROR: ['ERROR', 'IDLE']
};

export const RECEIVER_ERROR_CODES = {
  END_INCOMPLETE: 'END_INCOMPLETE',
  NO_PROGRESS_TIMEOUT: 'NO_PROGRESS_TIMEOUT',
  MISSING_PACKET: 'MISSING_PACKET',
  FILE_CRC_MISMATCH: 'FILE_CRC_MISMATCH',
  FILE_SIZE_MISMATCH: 'FILE_SIZE_MISMATCH',
  HEADER_CONFLICT: 'HEADER_CONFLICT'
} as const;

export type ReceiverErrorCode = (typeof RECEIVER_ERROR_CODES)[keyof typeof RECEIVER_ERROR_CODES];

export interface ReceiverMachineError {
  code: ReceiverErrorCode;
  message: string;
}

export interface ReceiverSnapshot {
  state: ReceiverState;
  transferId: string | null;
  fileName: string;
  expectedFileSize: number | null;
  totalPackets: number | null;
  fileCrc32: number | null;
  receivedCount: number;
  totalScans: number;
  lastUniquePacketAt: number | null;
  lastLockedTransferFrameAt: number | null;
  endSeenAt: number | null;
  lockConfirmed: boolean;
  headerConfirmations: number;
  candidateTransferId: string | null;
  lastContiguousPacketIndex: number;
  missingRanges: Array<{ start: number; end: number }>;
  fileBytes?: Uint8Array;
  error?: ReceiverMachineError;
}

export type ReceiverGapEventType = 'gap_detected' | 'gap_filled' | 'gap_lost';

export interface ReceiverGapEvent {
  type: ReceiverGapEventType;
  streamId: string;
  expectedSeq: number;
  receivedSeq: number;
  gapSize: number;
  rangeStart: number;
  rangeEnd: number;
  retransmitRequested: boolean;
  permanentlyLost: boolean;
}

function transferIdToKey(transferId: Uint8Array): string {
  let result = '';
  for (let i = 0; i < transferId.length; i += 1) {
    result += transferId[i].toString(16).padStart(2, '0');
  }
  return result;
}

function clearBitset(bitset: Uint8Array): void {
  bitset.fill(0);
}

function hasBit(bitset: Uint8Array, index: number): boolean {
  const byteIndex = index >> 3;
  const bitMask = 1 << (index & 7);
  return (bitset[byteIndex] & bitMask) !== 0;
}

function setBit(bitset: Uint8Array, index: number): void {
  const byteIndex = index >> 3;
  const bitMask = 1 << (index & 7);
  bitset[byteIndex] |= bitMask;
}

function toHeaderSignature(frame: TransferHeaderFrame): string {
  return `${transferIdToKey(frame.transferId)}|${frame.fileName || 'received.bin'}|${frame.fileSize}|${frame.totalPackets}|${frame.fileCrc32}`;
}

export class ReceiverMachine {
  private readonly onGapEvent?: (event: ReceiverGapEvent) => void;

  private snapshotValue: ReceiverSnapshot = {
    state: 'IDLE',
    transferId: null,
    fileName: '',
    expectedFileSize: null,
    totalPackets: null,
    fileCrc32: null,
    receivedCount: 0,
    totalScans: 0,
    lastUniquePacketAt: null,
    lastLockedTransferFrameAt: null,
    endSeenAt: null,
    lockConfirmed: false,
    headerConfirmations: 0,
    candidateTransferId: null,
    lastContiguousPacketIndex: -1,
    missingRanges: []
  };

  private packetPayloads: Array<Uint8Array | null> = [];

  private packetSeen = new Uint8Array(0);

  private receivedPacketCount = 0;

  private pendingHeaderSignature: string | null = null;

  private pendingHeaderFirstSeenAt: number | null = null;

  private maxObservedPacketIndex = -1;

  private activeGapKeys = new Set<string>();

  constructor(options?: { onGapEvent?: (event: ReceiverGapEvent) => void }) {
    this.onGapEvent = options?.onGapEvent;
  }

  public startScanning(): void {
    this.reset();
    this.setState('SCANNING');
  }

  public reset(): void {
    this.snapshotValue = {
      state: 'IDLE',
      transferId: null,
      fileName: '',
      expectedFileSize: null,
      totalPackets: null,
      fileCrc32: null,
      receivedCount: 0,
      totalScans: 0,
      lastUniquePacketAt: null,
      lastLockedTransferFrameAt: null,
      endSeenAt: null,
      lockConfirmed: false,
      headerConfirmations: 0,
      candidateTransferId: null,
      lastContiguousPacketIndex: -1,
      missingRanges: []
    };
    this.packetPayloads = [];
    this.packetSeen = new Uint8Array(0);
    this.receivedPacketCount = 0;
    this.pendingHeaderSignature = null;
    this.pendingHeaderFirstSeenAt = null;
    this.maxObservedPacketIndex = -1;
    this.activeGapKeys.clear();
  }

  public get snapshot(): ReceiverSnapshot {
    return {
      ...this.snapshotValue,
      missingRanges: this.snapshotValue.missingRanges.map((range) => ({ ...range }))
    };
  }

  public applyFrame(frame: TransferFrame, now: number): ReceiverSnapshot {
    if (this.snapshotValue.state === 'ERROR' || this.snapshotValue.state === 'SUCCESS') {
      return this.snapshot;
    }

    if (frame.frameType === FRAME_TYPE_HEADER) {
      this.snapshotValue.totalScans += 1;
      this.applyHeader(frame, now);
      return this.evaluateCompletion();
    }
    if (frame.frameType === FRAME_TYPE_DATA) {
      this.snapshotValue.totalScans += 1;
      this.applyData(frame, now);
      return this.evaluateCompletion();
    }
    if (frame.frameType === FRAME_TYPE_END) {
      this.snapshotValue.totalScans += 1;
      this.applyEnd(frame, now);
      return this.evaluateCompletion();
    }

    throw new ProtocolError(
      PROTOCOL_ERROR_CODES.UNSUPPORTED_FRAME_TYPE,
      `Unsupported frame type in receiver dispatch: ${String((frame as { frameType?: unknown }).frameType)}`
    );
  }

  public tick(now: number): ReceiverSnapshot {
    if (this.snapshotValue.state !== 'SCANNING' && this.snapshotValue.state !== 'RECEIVING') {
      return this.snapshot;
    }

    if (
      this.snapshotValue.lockConfirmed
      && this.snapshotValue.lastUniquePacketAt !== null
      && now - this.snapshotValue.lastUniquePacketAt > RECEIVER_TIMEOUTS.NO_UNIQUE_PROGRESS_TIMEOUT_MS
      && (
        this.snapshotValue.lastLockedTransferFrameAt === null
        || now - this.snapshotValue.lastLockedTransferFrameAt > RECEIVER_TIMEOUTS.LOCKED_TRANSFER_ACTIVITY_GRACE_MS
      )
    ) {
      return this.fail(RECEIVER_ERROR_CODES.NO_PROGRESS_TIMEOUT, 'No new unique packets for 15 seconds after transfer lock.');
    }

    if (
      this.snapshotValue.lockConfirmed
      && this.snapshotValue.endSeenAt !== null
      && this.snapshotValue.totalPackets !== null
      && this.receivedPacketCount < this.snapshotValue.totalPackets
      && now - this.snapshotValue.endSeenAt > RECEIVER_TIMEOUTS.END_GRACE_MS
    ) {
      return this.fail(RECEIVER_ERROR_CODES.END_INCOMPLETE, 'END frame seen before all packets were received.');
    }

    return this.snapshot;
  }

  private applyHeader(frame: TransferHeaderFrame, now: number): void {
    const incomingTransferId = transferIdToKey(frame.transferId);

    if (!this.snapshotValue.lockConfirmed) {
      this.observeHeaderCandidate(frame, incomingTransferId, now);
      return;
    }

    if (this.snapshotValue.transferId && this.snapshotValue.transferId !== incomingTransferId) {
      return;
    }

    this.snapshotValue.lastLockedTransferFrameAt = now;

    const hasConflict = (
      this.snapshotValue.fileName !== (frame.fileName || 'received.bin')
      || this.snapshotValue.expectedFileSize !== frame.fileSize
      || this.snapshotValue.totalPackets !== frame.totalPackets
      || this.snapshotValue.fileCrc32 !== frame.fileCrc32
    );

    if (hasConflict) {
      this.fail(RECEIVER_ERROR_CODES.HEADER_CONFLICT, 'Conflicting HEADER metadata for active transferId.');
    }
  }

  private observeHeaderCandidate(frame: TransferHeaderFrame, incomingTransferId: string, now: number): void {
    const signature = toHeaderSignature(frame);

    if (
      this.pendingHeaderSignature !== signature
      || this.pendingHeaderFirstSeenAt === null
      || now - this.pendingHeaderFirstSeenAt > RECEIVER_LOCK_CONFIRMATION.WINDOW_MS
    ) {
      this.pendingHeaderSignature = signature;
      this.pendingHeaderFirstSeenAt = now;
      this.snapshotValue.headerConfirmations = 1;
      this.snapshotValue.candidateTransferId = incomingTransferId;
      return;
    }

    this.snapshotValue.headerConfirmations += 1;
    this.snapshotValue.candidateTransferId = incomingTransferId;

    if (this.snapshotValue.headerConfirmations < RECEIVER_LOCK_CONFIRMATION.REQUIRED_HEADERS) {
      return;
    }

    this.snapshotValue.transferId = incomingTransferId;
    this.snapshotValue.fileName = frame.fileName || 'received.bin';
    this.snapshotValue.expectedFileSize = frame.fileSize;
    this.snapshotValue.totalPackets = frame.totalPackets;
    this.snapshotValue.fileCrc32 = frame.fileCrc32;
    this.snapshotValue.lastUniquePacketAt = now;
    this.snapshotValue.lastLockedTransferFrameAt = now;
    this.packetPayloads = Array.from({ length: frame.totalPackets }, () => null);
    this.packetSeen = new Uint8Array(Math.ceil(frame.totalPackets / 8));
    clearBitset(this.packetSeen);
    this.receivedPacketCount = 0;
    this.maxObservedPacketIndex = -1;
    this.activeGapKeys.clear();
    this.snapshotValue.receivedCount = 0;
    this.snapshotValue.lastContiguousPacketIndex = -1;
    this.snapshotValue.missingRanges = [];
    this.snapshotValue.lockConfirmed = true;
    this.setState('RECEIVING');
  }

  private applyData(frame: TransferDataFrame, now: number): void {
    if (!this.snapshotValue.lockConfirmed || !this.snapshotValue.transferId || this.snapshotValue.totalPackets === null) return;
    if (transferIdToKey(frame.transferId) !== this.snapshotValue.transferId) return;

    this.snapshotValue.lastLockedTransferFrameAt = now;

    if (frame.packetIndex < 0 || frame.packetIndex >= this.snapshotValue.totalPackets) return;
    if (hasBit(this.packetSeen, frame.packetIndex)) return;

    this.packetPayloads[frame.packetIndex] = frame.payload;
    setBit(this.packetSeen, frame.packetIndex);
    this.maxObservedPacketIndex = Math.max(this.maxObservedPacketIndex, frame.packetIndex);
    this.receivedPacketCount += 1;
    this.snapshotValue.receivedCount = this.receivedPacketCount;
    this.snapshotValue.lastUniquePacketAt = now;
    this.reconcileGapState(frame.packetIndex);
  }

  private applyEnd(frame: TransferEndFrame, now: number): void {
    if (!this.snapshotValue.lockConfirmed || !this.snapshotValue.transferId) return;
    if (transferIdToKey(frame.transferId) !== this.snapshotValue.transferId) return;
    this.snapshotValue.lastLockedTransferFrameAt = now;
    this.snapshotValue.endSeenAt = now;
  }

  private evaluateCompletion(): ReceiverSnapshot {
    if (!this.snapshotValue.lockConfirmed || this.snapshotValue.totalPackets === null || this.snapshotValue.fileCrc32 === null) {
      return this.snapshot;
    }

    if (this.snapshotValue.totalPackets === 0) {
      if (this.snapshotValue.endSeenAt === null) {
        return this.snapshot;
      }

      this.setState('VERIFYING');
      const fileBytes = new Uint8Array(0);

      if (calculateCRC32(fileBytes) !== this.snapshotValue.fileCrc32) {
        return this.fail(RECEIVER_ERROR_CODES.FILE_CRC_MISMATCH, 'File CRC32 mismatch detected.');
      }

      if (this.snapshotValue.expectedFileSize !== 0) {
        return this.fail(RECEIVER_ERROR_CODES.FILE_SIZE_MISMATCH, 'File size mismatch detected during verification.');
      }

      this.setState('SUCCESS');
      this.snapshotValue.fileBytes = fileBytes;
      return this.snapshot;
    }

    if (this.receivedPacketCount !== this.snapshotValue.totalPackets) {
      return this.snapshot;
    }

    this.snapshotValue.state = 'VERIFYING';

    const expectedSize = this.snapshotValue.expectedFileSize ?? 0;
    const fileBytes = new Uint8Array(expectedSize);
    let offset = 0;

    for (let i = 0; i < this.snapshotValue.totalPackets; i += 1) {
      const packet = this.packetPayloads[i];
      if (!packet) {
        return this.fail(RECEIVER_ERROR_CODES.MISSING_PACKET, 'Missing packets detected during verification.');
      }
      fileBytes.set(packet, offset);
      offset += packet.length;
    }

    if (offset !== expectedSize) {
      return this.fail(RECEIVER_ERROR_CODES.FILE_SIZE_MISMATCH, 'File size mismatch detected during verification.');
    }

    if (calculateCRC32(fileBytes) !== this.snapshotValue.fileCrc32) {
      return this.fail(RECEIVER_ERROR_CODES.FILE_CRC_MISMATCH, 'File CRC32 mismatch detected.');
    }

    this.snapshotValue.state = 'SUCCESS';
    this.snapshotValue.fileBytes = fileBytes;
    return this.snapshot;
  }

  private setState(next: ReceiverState): void {
    const allowed = RECEIVER_STATE_TRANSITIONS[this.snapshotValue.state];
    if (!allowed.includes(next)) {
      throw new Error(`Invalid receiver transition: ${this.snapshotValue.state} -> ${next}`);
    }
    this.snapshotValue.state = next;
  }

  private fail(code: ReceiverErrorCode, message: string): ReceiverSnapshot {
    if (
      this.snapshotValue.lockConfirmed
      && this.snapshotValue.transferId
      && (code === RECEIVER_ERROR_CODES.NO_PROGRESS_TIMEOUT || code === RECEIVER_ERROR_CODES.END_INCOMPLETE)
    ) {
      for (const range of this.snapshotValue.missingRanges) {
        this.emitGapEvent('gap_lost', range.start, range.end, this.maxObservedPacketIndex);
      }
      this.activeGapKeys.clear();
    }
    this.setState('ERROR');
    this.snapshotValue.error = { code, message };
    return this.snapshot;
  }

  private reconcileGapState(receivedSeq: number): void {
    if (!this.snapshotValue.lockConfirmed || this.snapshotValue.totalPackets === null) return;

    let contiguous = -1;
    const scanLimit = this.maxObservedPacketIndex;
    for (let i = 0; i <= scanLimit; i += 1) {
      if (!hasBit(this.packetSeen, i)) break;
      contiguous = i;
    }
    this.snapshotValue.lastContiguousPacketIndex = contiguous;

    const currentRanges: Array<{ start: number; end: number }> = [];
    let cursor = contiguous + 1;
    while (cursor <= scanLimit) {
      if (hasBit(this.packetSeen, cursor)) {
        cursor += 1;
        continue;
      }
      const start = cursor;
      while (cursor <= scanLimit && !hasBit(this.packetSeen, cursor)) {
        cursor += 1;
      }
      const end = cursor - 1;
      currentRanges.push({ start, end });
    }
    this.snapshotValue.missingRanges = currentRanges;

    const currentKeys = new Set(currentRanges.map((range) => `${range.start}-${range.end}`));
    const resolvedKeys: string[] = [];
    for (const gapKey of this.activeGapKeys) {
      if (!currentKeys.has(gapKey)) {
        const [startStr, endStr] = gapKey.split('-');
        this.emitGapEvent('gap_filled', Number(startStr), Number(endStr), receivedSeq);
        resolvedKeys.push(gapKey);
      }
    }
    for (const gapKey of resolvedKeys) {
      this.activeGapKeys.delete(gapKey);
    }

    for (const range of currentRanges) {
      const key = `${range.start}-${range.end}`;
      if (this.activeGapKeys.has(key)) continue;
      this.activeGapKeys.add(key);
      this.emitGapEvent('gap_detected', range.start, range.end, receivedSeq);
    }
  }

  private emitGapEvent(type: ReceiverGapEventType, rangeStart: number, rangeEnd: number, receivedSeq: number): void {
    if (!this.snapshotValue.transferId) return;
    this.onGapEvent?.({
      type,
      streamId: this.snapshotValue.transferId,
      expectedSeq: rangeStart,
      receivedSeq,
      gapSize: (rangeEnd - rangeStart) + 1,
      rangeStart,
      rangeEnd,
      retransmitRequested: false,
      permanentlyLost: type === 'gap_lost'
    });
  }
}
