import QRCode from 'qrcode';
import {
  PROTOCOL_ERROR_CODES,
  ProtocolError,
  assembleFrame,
  calculateCRC32,
  chunkFile,
  createTransferId,
  FRAME_TYPE_DATA,
  FRAME_TYPE_END,
  FRAME_TYPE_HEADER,
  type TransferDataFrame,
  type TransferEndFrame,
  type TransferFrame,
  type TransferHeaderFrame
} from '@qr-data-bridge/protocol';

export const MAX_FILE_SIZE_BYTES = 1024 * 1024;
export const LARGE_FILE_WARNING_BYTES = 512 * 1024;
export const LARGE_FILE_WARNING_COPY = 'Large files may take a long time and may fail more often.';

export const DEFAULT_DATA_FRAME_DURATION_MS = 2000;
export const HEADER_HOLD_MS = 2000;
export const END_HOLD_MS = 3000;

const TRANSFER_ID_SIZE = 8;
const textEncoder = new TextEncoder();

export interface SenderFailure {
  title: string;
  warning: string;
}

export interface BrowserFileLike {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface SenderTransmissionPlan {
  fileBytes: Uint8Array;
  transferId: Uint8Array;
  fileName: string;
  fileSize: number;
  totalDataPackets: number;
  maxPayloadSize: number;
  packetOffsets: Uint32Array;
  packetLengths: Uint16Array;
  packetCrc32: Uint32Array;
  headerFrame: TransferHeaderFrame;
  endFrame: TransferEndFrame;
  headerBytes: Uint8Array;
  endBytes: Uint8Array;
}

export interface SenderStreamFrame {
  frameType: number;
  packetIndex?: number;
}

export const SENDER_ERROR_COPY_MAP = {
  FILE_TOO_LARGE: {
    title: 'File too large',
    warning: LARGE_FILE_WARNING_COPY
  },
  FILE_READ_FAILED: {
    titlePrefix: 'Error: file read failed:',
    warning: 'Try re-selecting the file and restart transmission.'
  },
  INVALID_PREFLIGHT_SETTINGS: {
    titlePrefix: 'Error: invalid preflight settings:',
    warning: 'Adjust QR size, error correction, or chunk size and retry transmission.'
  },
  FRAME_PRECOMPUTE_FAILED: {
    titlePrefix: 'Error: frame precompute failed:',
    warning: 'Adjust settings and retry transmission.'
  },
  QR_ENCODE_FAILED: {
    titlePrefix: 'Error: QR encode failed:',
    warning: 'Adjust settings and retry transmission.'
  },
  FILENAME_LIMIT: {
    titlePrefix: 'Error: filename limit exceeded:',
    warning: 'Rename the file to a shorter UTF-8 name and try again.'
  },
  TOO_MANY_PACKETS: {
    titlePrefix: 'Error: too many packets:',
    warning: 'Increase chunk size or pick a smaller file.'
  },
  PACKETIZATION_FAILED: {
    titlePrefix: 'Error: packetization failed:',
    warning: 'Adjust settings and retry transmission.'
  }
} as const;

function asErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function assertUint16(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new ProtocolError(PROTOCOL_ERROR_CODES.INVALID_UINT16, `${fieldName} must be a uint16.`);
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

export function getFrameDisplayDurationMs(frame: Pick<SenderStreamFrame, 'frameType'>, dataFrameDurationMs = DEFAULT_DATA_FRAME_DURATION_MS): number {
  if (frame.frameType === FRAME_TYPE_HEADER) return HEADER_HOLD_MS;
  if (frame.frameType === FRAME_TYPE_END) return END_HOLD_MS;
  return dataFrameDurationMs;
}

export function estimateTransmissionDurationMs(frames: TransferFrame[], dataFrameDurationMs?: number): number;
export function estimateTransmissionDurationMs(totalDataPackets: number, redundancyCount: number, dataFrameDurationMs?: number): number;
export function estimateTransmissionDurationMs(
  framesOrTotalDataPackets: TransferFrame[] | number,
  redundancyOrDataFrameDurationMs?: number,
  maybeDataFrameDurationMs = DEFAULT_DATA_FRAME_DURATION_MS
): number {
  if (Array.isArray(framesOrTotalDataPackets)) {
    const dataFrameDurationMs = redundancyOrDataFrameDurationMs ?? DEFAULT_DATA_FRAME_DURATION_MS;
    return framesOrTotalDataPackets.reduce((sum, frame) => sum + getFrameDisplayDurationMs(frame, dataFrameDurationMs), 0);
  }

  const totalDataPackets = framesOrTotalDataPackets;
  const redundancyCount = redundancyOrDataFrameDurationMs ?? 1;
  const dataFrameDurationMs = maybeDataFrameDurationMs;
  const totalDataScans = totalDataPackets * redundancyCount;
  return HEADER_HOLD_MS + END_HOLD_MS + (totalDataScans * dataFrameDurationMs);
}

export function getTotalScans(totalDataPackets: number, redundancyCount: number): number {
  return (totalDataPackets * redundancyCount) + 2;
}

export function getStreamFrameAtIndex(totalDataPackets: number, redundancyCount: number, index: number): SenderStreamFrame {
  const totalScans = getTotalScans(totalDataPackets, redundancyCount);
  if (index < 0 || index >= totalScans) {
    throw new Error(`Frame index out of range: ${index}/${totalScans}`);
  }
  if (index === 0) return { frameType: FRAME_TYPE_HEADER };
  if (index === totalScans - 1) return { frameType: FRAME_TYPE_END };
  const dataScanIndex = index - 1;
  return {
    frameType: FRAME_TYPE_DATA,
    packetIndex: Math.floor(dataScanIndex / redundancyCount)
  };
}

export function createTransmissionPlan(fileBytes: Uint8Array, fileName: string, maxPayloadSize: number): SenderTransmissionPlan {
  const normalizedFileName = fileName.trim();
  if (!normalizedFileName) {
    throw new ProtocolError(PROTOCOL_ERROR_CODES.INVALID_FILE_NAME, 'fileName must not be empty.');
  }
  if (!Number.isInteger(maxPayloadSize) || maxPayloadSize < 1 || maxPayloadSize > 1024) {
    throw new ProtocolError(PROTOCOL_ERROR_CODES.INVALID_PAYLOAD_LENGTH, 'maxPayloadSize must be between 1 and 1024.');
  }

  const totalDataPackets = fileBytes.length === 0 ? 0 : Math.ceil(fileBytes.length / maxPayloadSize);
  try {
    assertUint16(totalDataPackets, 'totalPackets');
  } catch (error) {
    if (error instanceof ProtocolError && error.code === PROTOCOL_ERROR_CODES.INVALID_UINT16) {
      throw new ProtocolError(PROTOCOL_ERROR_CODES.PACKET_BOUNDS, 'totalPackets exceeds protocol limits.');
    }
    throw error;
  }

  const transferId = createTransferId();
  const encodedFileName = textEncoder.encode(normalizedFileName);
  assertUint16(encodedFileName.length, 'fileName byte length');
  const fileCrc32 = calculateCRC32(fileBytes);

  const packetOffsets = new Uint32Array(totalDataPackets);
  const packetLengths = new Uint16Array(totalDataPackets);
  const packetCrc32 = new Uint32Array(totalDataPackets);

  for (let packetIndex = 0; packetIndex < totalDataPackets; packetIndex += 1) {
    const start = packetIndex * maxPayloadSize;
    const end = Math.min(start + maxPayloadSize, fileBytes.length);
    const payload = fileBytes.subarray(start, end);
    packetOffsets[packetIndex] = start;
    packetLengths[packetIndex] = payload.length;
    packetCrc32[packetIndex] = computePacketCrc32(transferId, packetIndex, payload);
  }

  const headerFrame: TransferHeaderFrame = {
    frameType: FRAME_TYPE_HEADER,
    transferId,
    fileName: normalizedFileName,
    fileSize: fileBytes.length,
    totalPackets: totalDataPackets,
    fileCrc32,
    headerCrc32: computeHeaderCrc32({
      transferId,
      encodedFileName,
      fileSize: fileBytes.length,
      totalPackets: totalDataPackets,
      fileCrc32
    })
  };

  const endFrame: TransferEndFrame = { frameType: FRAME_TYPE_END, transferId };

  return {
    fileBytes,
    transferId,
    fileName: normalizedFileName,
    fileSize: fileBytes.length,
    totalDataPackets,
    maxPayloadSize,
    packetOffsets,
    packetLengths,
    packetCrc32,
    headerFrame,
    endFrame,
    headerBytes: assembleFrame(headerFrame),
    endBytes: assembleFrame(endFrame)
  };
}

export function getDataFrameBytes(plan: SenderTransmissionPlan, packetIndex: number): Uint8Array {
  if (!Number.isInteger(packetIndex) || packetIndex < 0 || packetIndex >= plan.totalDataPackets) {
    throw new Error(`Packet index out of bounds: ${packetIndex}`);
  }
  const start = plan.packetOffsets[packetIndex];
  const len = plan.packetLengths[packetIndex];
  const payload = plan.fileBytes.subarray(start, start + len);
  const frame: TransferDataFrame = {
    frameType: FRAME_TYPE_DATA,
    transferId: plan.transferId,
    packetIndex,
    payloadLen: len,
    payload,
    packetCrc32: plan.packetCrc32[packetIndex]
  };
  return assembleFrame(frame);
}

export async function encodeFrameBytesToCanvas(
  frameBytes: Uint8Array,
  qrCanvas: HTMLCanvasElement,
  options: { qrErrorCorrection: QRCode.QRCodeErrorCorrectionLevel; qrSizePx: number },
  deps: { toCanvas: typeof QRCode.toCanvas } = { toCanvas: QRCode.toCanvas }
): Promise<void> {
  try {
    const payload: QRCode.QRCodeSegment[] = [{ mode: 'byte', data: frameBytes }];
    await deps.toCanvas(qrCanvas, payload, {
      errorCorrectionLevel: options.qrErrorCorrection,
      width: options.qrSizePx,
      margin: 1,
      color: { dark: '#000000', light: '#FFFFFF' }
    });
  } catch (error) {
    const message = asErrorMessage(error, 'Unknown QR encoding error.');
    throw new Error(`Error: QR encode failed: ${message}`);
  }
}

export async function encodeFrameToCanvas(
  frame: TransferFrame,
  qrCanvas: HTMLCanvasElement,
  options: { qrErrorCorrection: QRCode.QRCodeErrorCorrectionLevel; qrSizePx: number },
  deps: { toCanvas: typeof QRCode.toCanvas } = { toCanvas: QRCode.toCanvas }
): Promise<void> {
  await encodeFrameBytesToCanvas(assembleFrame(frame), qrCanvas, options, deps);
}

function getLargestPacketIndex(lengths: Uint16Array): number | null {
  if (lengths.length === 0) return null;
  let largestIndex = 0;
  let largestLen = lengths[0];
  for (let i = 1; i < lengths.length; i += 1) {
    if (lengths[i] > largestLen) {
      largestLen = lengths[i];
      largestIndex = i;
    }
  }
  return largestIndex;
}

export async function preflightTransmissionPlan(
  plan: SenderTransmissionPlan,
  options: { qrErrorCorrection: QRCode.QRCodeErrorCorrectionLevel; qrSizePx: number; strictAllDataFrames?: boolean },
  deps: { toCanvas: typeof QRCode.toCanvas } = { toCanvas: QRCode.toCanvas }
): Promise<void> {
  const canvas = document.createElement('canvas');
  try {
    await encodeFrameBytesToCanvas(plan.headerBytes, canvas, options, deps);
    const largestPacketIndex = getLargestPacketIndex(plan.packetLengths);
    if (largestPacketIndex !== null) {
      if (options.strictAllDataFrames) {
        for (let i = 0; i < plan.totalDataPackets; i += 1) {
          await encodeFrameBytesToCanvas(getDataFrameBytes(plan, i), canvas, options, deps);
        }
      } else {
        await encodeFrameBytesToCanvas(getDataFrameBytes(plan, largestPacketIndex), canvas, options, deps);
      }
    }
    await encodeFrameBytesToCanvas(plan.endBytes, canvas, options, deps);
  } catch (error) {
    const message = asErrorMessage(error, 'Unknown preflight failure.');
    throw new Error(`Error: frame precompute failed: ${message}`);
  }
}


export async function preflightEncodeFrames(
  frames: TransferFrame[],
  options: { qrErrorCorrection: QRCode.QRCodeErrorCorrectionLevel; qrSizePx: number },
  deps: { toCanvas: typeof QRCode.toCanvas } = { toCanvas: QRCode.toCanvas }
): Promise<void> {
  if (frames.length === 0) {
    throw new Error('Error: frame precompute failed: no frames to encode.');
  }
  const canvas = document.createElement('canvas');
  try {
    for (const frame of frames) {
      await encodeFrameToCanvas(frame, canvas, options, deps);
    }
  } catch (error) {
    const message = asErrorMessage(error, 'Unknown preflight failure.');
    throw new Error(`Error: frame precompute failed: ${message}`);
  }
}

export async function preflightBuildFrameDataUrls(
  frames: TransferFrame[],
  options: { qrErrorCorrection: QRCode.QRCodeErrorCorrectionLevel; qrSizePx: number },
  deps: { toCanvas: typeof QRCode.toCanvas } = { toCanvas: QRCode.toCanvas }
): Promise<string[]> {
  if (frames.length === 0) {
    throw new Error('Error: frame precompute failed: no frames to encode.');
  }
  const canvas = document.createElement('canvas');
  const urls: string[] = [];
  try {
    for (const frame of frames) {
      await encodeFrameToCanvas(frame, canvas, options, deps);
      urls.push(canvas.toDataURL('image/png'));
    }
    return urls;
  } catch (error) {
    const message = asErrorMessage(error, 'Unknown preflight failure.');
    throw new Error(`Error: frame precompute failed: ${message}`);
  }
}

export function toUserFacingPreflightError(error: unknown): SenderFailure {
  const message = asErrorMessage(error, 'Unknown preflight failure.');
  return {
    title: `${SENDER_ERROR_COPY_MAP.INVALID_PREFLIGHT_SETTINGS.titlePrefix} ${message}`,
    warning: SENDER_ERROR_COPY_MAP.INVALID_PREFLIGHT_SETTINGS.warning
  };
}

export function toUserFacingSenderError(error: unknown): SenderFailure {
  if (error instanceof ProtocolError) {
    if (error.code === PROTOCOL_ERROR_CODES.INVALID_FILE_NAME || error.code === PROTOCOL_ERROR_CODES.INVALID_UINT16) {
      return {
        title: `${SENDER_ERROR_COPY_MAP.FILENAME_LIMIT.titlePrefix} ${error.message}`,
        warning: SENDER_ERROR_COPY_MAP.FILENAME_LIMIT.warning
      };
    }

    if (error.code === PROTOCOL_ERROR_CODES.PACKET_BOUNDS) {
      return {
        title: `${SENDER_ERROR_COPY_MAP.TOO_MANY_PACKETS.titlePrefix} ${error.message}`,
        warning: SENDER_ERROR_COPY_MAP.TOO_MANY_PACKETS.warning
      };
    }

    return {
      title: `${SENDER_ERROR_COPY_MAP.PACKETIZATION_FAILED.titlePrefix} ${error.message}`,
      warning: SENDER_ERROR_COPY_MAP.PACKETIZATION_FAILED.warning
    };
  }

  const message = asErrorMessage(error, 'Packetization failed.');
  return {
    title: `${SENDER_ERROR_COPY_MAP.PACKETIZATION_FAILED.titlePrefix} ${message}`,
    warning: SENDER_ERROR_COPY_MAP.PACKETIZATION_FAILED.warning
  };
}

export function validateFileBeforeTransmission(file: BrowserFileLike): SenderFailure | null {
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return {
      title: SENDER_ERROR_COPY_MAP.FILE_TOO_LARGE.title,
      warning: SENDER_ERROR_COPY_MAP.FILE_TOO_LARGE.warning
    };
  }
  return null;
}

export function getTransmissionWarnings(fileSizeBytes: number, estimatedDurationMs: number): string[] {
  const warnings: string[] = [];
  if (estimatedDurationMs > 10 * 60 * 1000) warnings.push(LARGE_FILE_WARNING_COPY);
  if (fileSizeBytes > LARGE_FILE_WARNING_BYTES) warnings.push(LARGE_FILE_WARNING_COPY);
  return Array.from(new Set(warnings));
}

export async function readFileBytes(file: BrowserFileLike): Promise<Uint8Array> {
  try {
    return new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    throw new Error(`Error: file read failed: ${asErrorMessage(error, 'Unable to read selected file.')}`);
  }
}

// Compatibility helper for existing tests/integration; main sender path now uses createTransmissionPlan.
export function buildTransmissionFrames(fileBytes: Uint8Array, fileName: string, maxPayloadSize: number): {
  frames: TransferFrame[];
  totalDataPackets: number;
} {
  const transfer = chunkFile(fileBytes, { fileName, maxPayloadSize, includeEndFrame: true });
  const frames: TransferFrame[] = [transfer.header, ...transfer.dataFrames, ...(transfer.endFrame ? [transfer.endFrame] : [])];
  return { frames, totalDataPackets: transfer.dataFrames.length };
}

export function frameLabel(frame: TransferFrame, totalDataPackets: number): string {
  return frame.frameType === FRAME_TYPE_DATA ? `packet ${frame.packetIndex + 1}/${totalDataPackets}` : 'meta';
}
