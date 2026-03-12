import QRCode from 'qrcode';
import {
  PROTOCOL_ERROR_CODES,
  ProtocolError,
  assembleFrame,
  chunkFile,
  FRAME_TYPE_DATA,
  FRAME_TYPE_END,
  FRAME_TYPE_HEADER,
  type TransferFrame
} from '@qr-data-bridge/protocol';

export const MAX_FILE_SIZE_BYTES = 1024 * 1024;
export const LARGE_FILE_WARNING_BYTES = 512 * 1024;
export const LARGE_FILE_WARNING_COPY = 'Large files may take a long time and may fail more often.';


export const FIXED_DATA_FRAME_DURATION_MS = 2000;
export const HEADER_HOLD_MS = 2000;
export const END_HOLD_MS = 3000;

export function getFrameDisplayDurationMs(frame: TransferFrame): number {
  if (frame.frameType === FRAME_TYPE_HEADER) return HEADER_HOLD_MS;
  if (frame.frameType === FRAME_TYPE_END) return END_HOLD_MS;
  return FIXED_DATA_FRAME_DURATION_MS;
}

export function estimateTransmissionDurationMs(frames: TransferFrame[]): number {
  return frames.reduce((sum, frame) => sum + getFrameDisplayDurationMs(frame), 0);
}


export interface SenderFailure {
  title: string;
  warning: string;
}

export interface BrowserFileLike {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
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

export function toUserFacingPreflightError(error: unknown): SenderFailure {
  const message = asErrorMessage(error, 'Unknown preflight failure.');
  return {
    title: `${SENDER_ERROR_COPY_MAP.INVALID_PREFLIGHT_SETTINGS.titlePrefix} ${message}`,
    warning: SENDER_ERROR_COPY_MAP.INVALID_PREFLIGHT_SETTINGS.warning
  };
}

function asErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
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

export function buildTransmissionFrames(fileBytes: Uint8Array, fileName: string, maxPayloadSize: number): {
  frames: TransferFrame[];
  totalDataPackets: number;
} {
  const transfer = chunkFile(fileBytes, { fileName, maxPayloadSize, includeEndFrame: true });
  const frames: TransferFrame[] = [transfer.header, ...transfer.dataFrames, ...(transfer.endFrame ? [transfer.endFrame] : [])];
  return { frames, totalDataPackets: transfer.dataFrames.length };
}

export async function encodeFrameToCanvas(
  frame: TransferFrame,
  qrCanvas: HTMLCanvasElement,
  options: { qrErrorCorrection: QRCode.QRCodeErrorCorrectionLevel; qrSizePx: number },
  deps: { toCanvas: typeof QRCode.toCanvas } = { toCanvas: QRCode.toCanvas }
): Promise<void> {
  try {
    const payload: QRCode.QRCodeSegment[] = [{ mode: 'byte', data: assembleFrame(frame) }];
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

export function frameLabel(frame: TransferFrame, totalDataPackets: number): string {
  return frame.frameType === FRAME_TYPE_DATA ? `packet ${frame.packetIndex + 1}/${totalDataPackets}` : 'meta';
}
