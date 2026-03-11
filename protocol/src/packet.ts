import { calculateCRC32 } from './crc32';
import {
  FRAME_TYPE_DATA,
  FRAME_TYPE_END,
  FRAME_TYPE_HEADER,
  LEGACY_MAGIC_BYTES,
  MAGIC_BYTES,
  type ChunkFileOptions,
  type ChunkedTransfer,
  type TransferDataFrame,
  type TransferEndFrame,
  type TransferFrame,
  type TransferHeaderFrame
} from './types';

export const DEFAULT_MAX_PAYLOAD_SIZE = 512;
const TRANSFER_ID_SIZE = 8;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function assertUint16(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`${fieldName} must be a uint16.`);
  }
}

function assertUint32(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`${fieldName} must be a uint32.`);
  }
}

function assertTransferId(transferId: Uint8Array): void {
  if (transferId.length !== TRANSFER_ID_SIZE) {
    throw new Error('transferId must be exactly 8 bytes.');
  }
}

export function createTransferId(): Uint8Array {
  const transferId = new Uint8Array(TRANSFER_ID_SIZE);
  crypto.getRandomValues(transferId);
  return transferId;
}

export function assembleFrame(frame: TransferFrame): Uint8Array {
  if (frame.frameType === FRAME_TYPE_HEADER) {
    return assembleHeaderFrame(frame);
  }

  if (frame.frameType === FRAME_TYPE_DATA) {
    return assembleDataFrame(frame);
  }

  return assembleEndFrame(frame);
}

function assembleHeaderFrame(frame: TransferHeaderFrame): Uint8Array {
  assertTransferId(frame.transferId);
  assertUint32(frame.fileSize, 'fileSize');
  assertUint16(frame.totalPackets, 'totalPackets');

  const encodedFileName = textEncoder.encode(frame.fileName.trim() || 'unnamed.bin');
  assertUint16(encodedFileName.length, 'fileName byte length');

  const bytes = new Uint8Array(4 + 1 + TRANSFER_ID_SIZE + 2 + encodedFileName.length + 4 + 2 + 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  bytes.set(MAGIC_BYTES, 0);
  view.setUint8(4, FRAME_TYPE_HEADER);
  bytes.set(frame.transferId, 5);
  view.setUint16(13, encodedFileName.length);
  bytes.set(encodedFileName, 15);
  const offset = 15 + encodedFileName.length;
  view.setUint32(offset, frame.fileSize);
  view.setUint16(offset + 4, frame.totalPackets);
  view.setUint32(offset + 6, frame.fileCrc32);
  return bytes;
}

function assembleDataFrame(frame: TransferDataFrame): Uint8Array {
  assertUint16(frame.packetIndex, 'packetIndex');
  const computedPacketCrc32 = calculateCRC32(frame.payload);
  if (computedPacketCrc32 !== frame.packetCrc32) {
    throw new Error('packetCrc32 mismatch for data payload.');
  }

  assertTransferId(frame.transferId);
  const bytes = new Uint8Array(4 + 1 + TRANSFER_ID_SIZE + 2 + frame.payload.length + 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  bytes.set(MAGIC_BYTES, 0);
  view.setUint8(4, FRAME_TYPE_DATA);
  bytes.set(frame.transferId, 5);
  view.setUint16(13, frame.packetIndex);
  bytes.set(frame.payload, 15);
  view.setUint32(15 + frame.payload.length, frame.packetCrc32);
  return bytes;
}

function assembleEndFrame(frame: TransferEndFrame): Uint8Array {
  assertTransferId(frame.transferId);
  const bytes = new Uint8Array(4 + 1 + TRANSFER_ID_SIZE);
  bytes.set(MAGIC_BYTES, 0);
  bytes[4] = FRAME_TYPE_END;
  bytes.set(frame.transferId, 5);
  return bytes;
}

export function parseFrame(frameBytes: Uint8Array): TransferFrame {
  if (frameBytes.length < 5) {
    throw new Error('Frame is too small.');
  }

  if (LEGACY_MAGIC_BYTES.every((byte, index) => frameBytes[index] === byte)) {
    throw new Error('Version Mismatch');
  }

  if (!MAGIC_BYTES.every((byte, index) => frameBytes[index] === byte)) {
    throw new Error('Invalid frame magic bytes.');
  }

  const frameType = frameBytes[4];
  if (frameType === FRAME_TYPE_HEADER) {
    return parseHeaderFrame(frameBytes);
  }
  if (frameType === FRAME_TYPE_DATA) {
    return parseDataFrame(frameBytes);
  }
  if (frameType === FRAME_TYPE_END) {
    return parseEndFrame(frameBytes);
  }

  throw new Error(`Unsupported frame type: ${frameType}`);
}

function parseHeaderFrame(frameBytes: Uint8Array): TransferHeaderFrame {
  if (frameBytes.length < 4 + 1 + TRANSFER_ID_SIZE + 2 + 4 + 2 + 4) {
    throw new Error('Header frame is too small.');
  }

  const view = new DataView(frameBytes.buffer, frameBytes.byteOffset, frameBytes.byteLength);
  const transferId = frameBytes.slice(5, 13);
  const fileNameLength = view.getUint16(13);
  const nameStart = 15;
  const nameEnd = nameStart + fileNameLength;
  const tailStart = nameEnd;

  if (tailStart + 10 > frameBytes.length) {
    throw new Error('Malformed header frame.');
  }

  const fileName = textDecoder.decode(frameBytes.slice(nameStart, nameEnd));
  const fileSize = view.getUint32(tailStart);
  const totalPackets = view.getUint16(tailStart + 4);
  const fileCrc32 = view.getUint32(tailStart + 6);

  return {
    frameType: FRAME_TYPE_HEADER,
    transferId,
    fileName,
    fileSize,
    totalPackets,
    fileCrc32
  };
}

function parseDataFrame(frameBytes: Uint8Array): TransferDataFrame {
  if (frameBytes.length < 4 + 1 + TRANSFER_ID_SIZE + 2 + 4) {
    throw new Error('Data frame is too small.');
  }

  const view = new DataView(frameBytes.buffer, frameBytes.byteOffset, frameBytes.byteLength);
  const transferId = frameBytes.slice(5, 13);
  const packetIndex = view.getUint16(13);
  const payloadStart = 15;
  const payloadEnd = frameBytes.length - 4;

  if (payloadEnd < payloadStart) {
    throw new Error('Malformed data frame payload offsets.');
  }

  const payload = frameBytes.slice(payloadStart, payloadEnd);
  const packetCrc32 = view.getUint32(payloadEnd);

  if (calculateCRC32(payload) !== packetCrc32) {
    throw new Error('Packet CRC32 check failed.');
  }

  return {
    frameType: FRAME_TYPE_DATA,
    transferId,
    packetIndex,
    payload,
    packetCrc32
  };
}

function parseEndFrame(frameBytes: Uint8Array): TransferEndFrame {
  if (frameBytes.length !== 4 + 1 + TRANSFER_ID_SIZE) {
    throw new Error('Malformed END frame.');
  }

  return {
    frameType: FRAME_TYPE_END,
    transferId: frameBytes.slice(5, 13)
  };
}

export function chunkFile(file: Uint8Array, options: ChunkFileOptions = {}): ChunkedTransfer {
  const maxPayloadSize = options.maxPayloadSize ?? DEFAULT_MAX_PAYLOAD_SIZE;
  if (maxPayloadSize <= 0 || !Number.isInteger(maxPayloadSize)) {
    throw new Error('maxPayloadSize must be a positive integer.');
  }

  const normalizedFileName = options.fileName?.trim() || 'unnamed.bin';
  const totalPackets = Math.max(1, Math.ceil(file.length / maxPayloadSize));
  assertUint16(totalPackets, 'totalPackets');

  const transferId = options.transferId ?? createTransferId();
  assertTransferId(transferId);

  const header: TransferHeaderFrame = {
    frameType: FRAME_TYPE_HEADER,
    transferId,
    fileName: normalizedFileName,
    fileSize: file.length,
    totalPackets,
    fileCrc32: calculateCRC32(file)
  };

  const dataFrames: TransferDataFrame[] = [];
  for (let packetIndex = 0; packetIndex < totalPackets; packetIndex += 1) {
    const start = packetIndex * maxPayloadSize;
    const end = Math.min(start + maxPayloadSize, file.length);
    const payload = file.slice(start, end);
    dataFrames.push({
      frameType: FRAME_TYPE_DATA,
      transferId: transferId.slice(),
      packetIndex,
      payload,
      packetCrc32: calculateCRC32(payload)
    });
  }

  const endFrame: TransferEndFrame | undefined = options.includeEndFrame
    ? {
        frameType: FRAME_TYPE_END,
        transferId: transferId.slice()
      }
    : undefined;

  return {
    header,
    dataFrames,
    endFrame
  };
}
