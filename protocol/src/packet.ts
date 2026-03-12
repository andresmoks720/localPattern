import { calculateCRC32 } from './crc32';
import {
  FRAME_TYPE_DATA,
  FRAME_TYPE_END,
  FRAME_TYPE_HEADER,
  LEGACY_MAGIC_BYTES,
  MAGIC_BYTES,
  PROTOCOL_ERROR_CODES,
  ProtocolError,
  type ChunkFileOptions,
  type ChunkedTransfer,
  type TransferDataFrame,
  type TransferEndFrame,
  type TransferFrame,
  type TransferHeaderFrame
} from './types';

export const DEFAULT_MAX_PAYLOAD_SIZE = 512;
export const MAX_DATA_PAYLOAD_SIZE = 1024;
const TRANSFER_ID_SIZE = 8;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function assertUint16(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new ProtocolError(PROTOCOL_ERROR_CODES.INVALID_UINT16, `${fieldName} must be a uint16.`);
  }
}

function assertUint32(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new ProtocolError(PROTOCOL_ERROR_CODES.INVALID_UINT32, `${fieldName} must be a uint32.`);
  }
}

function assertTransferId(transferId: Uint8Array): void {
  if (transferId.length !== TRANSFER_ID_SIZE) {
    throw new ProtocolError(PROTOCOL_ERROR_CODES.INVALID_TRANSFER_ID, 'transferId must be exactly 8 bytes.');
  }
}

function assertTotalPacketsInvariant(fileSize: number, totalPackets: number): void {
  if (fileSize === 0 && totalPackets !== 0) {
    throw new ProtocolError(PROTOCOL_ERROR_CODES.INVALID_TOTAL_PACKETS, 'totalPackets must be 0 when fileSize is 0.');
  }

  if (fileSize > 0 && totalPackets < 1) {
    throw new ProtocolError(PROTOCOL_ERROR_CODES.INVALID_TOTAL_PACKETS, 'totalPackets must be >= 1 for non-empty files.');
  }
}

function computeHeaderCrc32(frame: {
  transferId: Uint8Array;
  encodedFileName: Uint8Array;
  fileSize: number;
  totalPackets: number;
  fileCrc32: number;
}): number {
  const crcBytes = new Uint8Array(TRANSFER_ID_SIZE + 2 + frame.encodedFileName.length + 4 + 2 + 4);
  const view = new DataView(crcBytes.buffer, crcBytes.byteOffset, crcBytes.byteLength);

  crcBytes.set(frame.transferId, 0);
  view.setUint16(TRANSFER_ID_SIZE, frame.encodedFileName.length);
  crcBytes.set(frame.encodedFileName, TRANSFER_ID_SIZE + 2);

  const tailOffset = TRANSFER_ID_SIZE + 2 + frame.encodedFileName.length;
  view.setUint32(tailOffset, frame.fileSize);
  view.setUint16(tailOffset + 4, frame.totalPackets);
  view.setUint32(tailOffset + 6, frame.fileCrc32);

  return calculateCRC32(crcBytes);
}

function computePacketCrc32(transferId: Uint8Array, packetIndex: number, payload: Uint8Array): number {
  const crcBytes = new Uint8Array(TRANSFER_ID_SIZE + 2 + payload.length);
  const view = new DataView(crcBytes.buffer, crcBytes.byteOffset, crcBytes.byteLength);

  crcBytes.set(transferId, 0);
  view.setUint16(TRANSFER_ID_SIZE, packetIndex);
  crcBytes.set(payload, TRANSFER_ID_SIZE + 2);

  return calculateCRC32(crcBytes);
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

  if (frame.frameType === FRAME_TYPE_END) {
    return assembleEndFrame(frame);
  }

  throw new ProtocolError(PROTOCOL_ERROR_CODES.UNSUPPORTED_FRAME_TYPE, `Unsupported frame type: ${(frame as { frameType?: unknown }).frameType as string}`);
}

function assembleHeaderFrame(frame: TransferHeaderFrame): Uint8Array {
  assertTransferId(frame.transferId);
  assertUint32(frame.fileSize, 'fileSize');
  assertUint16(frame.totalPackets, 'totalPackets');
  assertTotalPacketsInvariant(frame.fileSize, frame.totalPackets);

  const normalizedFileName = frame.fileName.trim();
  if (!normalizedFileName) {
    throw new ProtocolError(PROTOCOL_ERROR_CODES.INVALID_FILE_NAME, 'fileName must not be empty.');
  }
  const encodedFileName = textEncoder.encode(normalizedFileName);
  assertUint16(encodedFileName.length, 'fileName byte length');

  const computedHeaderCrc32 = computeHeaderCrc32({
    transferId: frame.transferId,
    encodedFileName,
    fileSize: frame.fileSize,
    totalPackets: frame.totalPackets,
    fileCrc32: frame.fileCrc32
  });

  if (computedHeaderCrc32 !== frame.headerCrc32) {
    throw new ProtocolError(PROTOCOL_ERROR_CODES.HEADER_CRC_MISMATCH, 'headerCrc32 mismatch for header frame.');
  }

  const bytes = new Uint8Array(4 + 1 + TRANSFER_ID_SIZE + 2 + encodedFileName.length + 4 + 2 + 4 + 4);
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
  view.setUint32(offset + 10, frame.headerCrc32);
  return bytes;
}

function assembleDataFrame(frame: TransferDataFrame): Uint8Array {
  assertUint16(frame.packetIndex, 'packetIndex');
  assertTransferId(frame.transferId);

  if (!Number.isInteger(frame.payloadLen) || frame.payloadLen !== frame.payload.length) {
    throw new ProtocolError(PROTOCOL_ERROR_CODES.INVALID_PAYLOAD_LENGTH, 'payloadLen must exactly match payload byte length.');
  }
  if (frame.payloadLen < 1 || frame.payloadLen > MAX_DATA_PAYLOAD_SIZE) {
    throw new ProtocolError(PROTOCOL_ERROR_CODES.INVALID_PAYLOAD_LENGTH, `payloadLen must be between 1 and ${MAX_DATA_PAYLOAD_SIZE}.`);
  }

  const computedPacketCrc32 = computePacketCrc32(frame.transferId, frame.packetIndex, frame.payload);
  if (computedPacketCrc32 !== frame.packetCrc32) {
    throw new ProtocolError(PROTOCOL_ERROR_CODES.PACKET_CRC_MISMATCH, 'packetCrc32 mismatch for data payload.');
  }

  const bytes = new Uint8Array(4 + 1 + TRANSFER_ID_SIZE + 2 + 2 + frame.payload.length + 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  bytes.set(MAGIC_BYTES, 0);
  view.setUint8(4, FRAME_TYPE_DATA);
  bytes.set(frame.transferId, 5);
  view.setUint16(13, frame.packetIndex);
  view.setUint16(15, frame.payloadLen);
  bytes.set(frame.payload, 17);
  view.setUint32(17 + frame.payload.length, frame.packetCrc32);
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
    throw new ProtocolError(PROTOCOL_ERROR_CODES.FRAME_TOO_SMALL, 'Frame is too small.');
  }

  if (LEGACY_MAGIC_BYTES.every((byte, index) => frameBytes[index] === byte)) {
    throw new ProtocolError(PROTOCOL_ERROR_CODES.VERSION_MISMATCH, 'Version Mismatch');
  }

  if (!MAGIC_BYTES.every((byte, index) => frameBytes[index] === byte)) {
    throw new ProtocolError(PROTOCOL_ERROR_CODES.INVALID_MAGIC, 'Invalid frame magic bytes.');
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

  throw new ProtocolError(PROTOCOL_ERROR_CODES.UNSUPPORTED_FRAME_TYPE, `Unsupported frame type: ${frameType}`);
}

function parseHeaderFrame(frameBytes: Uint8Array): TransferHeaderFrame {
  if (frameBytes.length < 4 + 1 + TRANSFER_ID_SIZE + 2 + 4 + 2 + 4 + 4) {
    throw new ProtocolError(PROTOCOL_ERROR_CODES.MALFORMED_HEADER, 'Header frame is too small.');
  }

  const view = new DataView(frameBytes.buffer, frameBytes.byteOffset, frameBytes.byteLength);
  const transferId = frameBytes.slice(5, 13);
  const fileNameLength = view.getUint16(13);
  const nameStart = 15;
  const nameEnd = nameStart + fileNameLength;
  const tailStart = nameEnd;

  if (tailStart + 14 !== frameBytes.length) {
    throw new ProtocolError(PROTOCOL_ERROR_CODES.MALFORMED_HEADER, 'Malformed header frame.');
  }

  const fileName = textDecoder.decode(frameBytes.slice(nameStart, nameEnd));
  const fileSize = view.getUint32(tailStart);
  const totalPackets = view.getUint16(tailStart + 4);
  const fileCrc32 = view.getUint32(tailStart + 6);
  const headerCrc32 = view.getUint32(tailStart + 10);

  assertTotalPacketsInvariant(fileSize, totalPackets);

  const computedHeaderCrc32 = computeHeaderCrc32({
    transferId,
    encodedFileName: frameBytes.slice(nameStart, nameEnd),
    fileSize,
    totalPackets,
    fileCrc32
  });

  if (computedHeaderCrc32 !== headerCrc32) {
    throw new ProtocolError(PROTOCOL_ERROR_CODES.HEADER_CRC_MISMATCH, 'Header CRC32 check failed.');
  }

  return {
    frameType: FRAME_TYPE_HEADER,
    transferId,
    fileName,
    fileSize,
    totalPackets,
    fileCrc32,
    headerCrc32
  };
}

function parseDataFrame(frameBytes: Uint8Array): TransferDataFrame {
  if (frameBytes.length < 4 + 1 + TRANSFER_ID_SIZE + 2 + 2 + 1 + 4) {
    throw new ProtocolError(PROTOCOL_ERROR_CODES.MALFORMED_DATA, 'Data frame is too small.');
  }

  const view = new DataView(frameBytes.buffer, frameBytes.byteOffset, frameBytes.byteLength);
  const transferId = frameBytes.slice(5, 13);
  const packetIndex = view.getUint16(13);
  const payloadLen = view.getUint16(15);

  if (payloadLen < 1 || payloadLen > MAX_DATA_PAYLOAD_SIZE) {
    throw new ProtocolError(PROTOCOL_ERROR_CODES.INVALID_PAYLOAD_LENGTH, `payloadLen must be between 1 and ${MAX_DATA_PAYLOAD_SIZE}.`);
  }

  const payloadStart = 17;
  const payloadEnd = payloadStart + payloadLen;

  if (payloadEnd + 4 !== frameBytes.length) {
    throw new ProtocolError(PROTOCOL_ERROR_CODES.MALFORMED_DATA, 'Malformed data frame payload length/trailing bytes.');
  }

  const payload = frameBytes.slice(payloadStart, payloadEnd);
  const packetCrc32 = view.getUint32(payloadEnd);

  if (computePacketCrc32(transferId, packetIndex, payload) !== packetCrc32) {
    throw new ProtocolError(PROTOCOL_ERROR_CODES.PACKET_CRC_MISMATCH, 'Packet CRC32 check failed.');
  }

  return {
    frameType: FRAME_TYPE_DATA,
    transferId,
    packetIndex,
    payloadLen,
    payload,
    packetCrc32
  };
}

function parseEndFrame(frameBytes: Uint8Array): TransferEndFrame {
  if (frameBytes.length !== 4 + 1 + TRANSFER_ID_SIZE) {
    throw new ProtocolError(PROTOCOL_ERROR_CODES.MALFORMED_END, 'Malformed END frame.');
  }

  return {
    frameType: FRAME_TYPE_END,
    transferId: frameBytes.slice(5, 13)
  };
}

export function chunkFile(file: Uint8Array, options: ChunkFileOptions = {}): ChunkedTransfer {
  const maxPayloadSize = options.maxPayloadSize ?? DEFAULT_MAX_PAYLOAD_SIZE;
  if (maxPayloadSize <= 0 || !Number.isInteger(maxPayloadSize)) {
    throw new ProtocolError(PROTOCOL_ERROR_CODES.INVALID_MAX_PAYLOAD_SIZE, 'maxPayloadSize must be a positive integer.');
  }
  if (maxPayloadSize > MAX_DATA_PAYLOAD_SIZE) {
    throw new ProtocolError(PROTOCOL_ERROR_CODES.INVALID_MAX_PAYLOAD_SIZE, `maxPayloadSize must be <= ${MAX_DATA_PAYLOAD_SIZE}.`);
  }

  const normalizedFileName = options.fileName?.trim();
  if (!normalizedFileName) {
    throw new ProtocolError(PROTOCOL_ERROR_CODES.INVALID_FILE_NAME, 'fileName must not be empty.');
  }

  const totalPackets = file.length === 0 ? 0 : Math.ceil(file.length / maxPayloadSize);
  try {
    assertUint16(totalPackets, 'totalPackets');
  } catch (error) {
    if (error instanceof ProtocolError && error.code === PROTOCOL_ERROR_CODES.INVALID_UINT16) {
      throw new ProtocolError(PROTOCOL_ERROR_CODES.PACKET_BOUNDS, 'totalPackets exceeds protocol limits.');
    }
    throw error;
  }

  const transferId = options.transferId ?? createTransferId();
  assertTransferId(transferId);

  const encodedFileName = textEncoder.encode(normalizedFileName);
  assertUint16(encodedFileName.length, 'fileName byte length');

  const fileCrc32 = calculateCRC32(file);
  const headerCrc32 = computeHeaderCrc32({
    transferId,
    encodedFileName,
    fileSize: file.length,
    totalPackets,
    fileCrc32
  });

  const header: TransferHeaderFrame = {
    frameType: FRAME_TYPE_HEADER,
    transferId,
    fileName: normalizedFileName,
    fileSize: file.length,
    totalPackets,
    fileCrc32,
    headerCrc32
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
      payloadLen: payload.length,
      payload,
      packetCrc32: computePacketCrc32(transferId, packetIndex, payload)
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
