import QRCode from 'qrcode';
import {
  PROTOCOL_ERROR_CODES,
  ProtocolError,
  assembleFrame,
  chunkFile,
  FRAME_TYPE_DATA,
  type TransferFrame
} from '@qr-data-bridge/protocol';

export const MAX_FILE_SIZE_BYTES = 1024 * 1024;

export interface SenderFailure {
  title: string;
  warning: string;
}

export interface BrowserFileLike {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function asErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function toUserFacingSenderError(error: unknown): SenderFailure {
  if (error instanceof ProtocolError) {
    if (error.code === PROTOCOL_ERROR_CODES.INVALID_FILE_NAME) {
      return {
        title: `Error: filename limit exceeded: ${error.message}`,
        warning: 'Rename the file to a shorter UTF-8 name and try again.'
      };
    }

    if (error.code === PROTOCOL_ERROR_CODES.PACKET_BOUNDS) {
      return {
        title: `Error: too many packets: ${error.message}`,
        warning: 'Increase chunk size or pick a smaller file.'
      };
    }

    return {
      title: `Error: packetization failed: ${error.message}`,
      warning: 'Adjust settings and retry transmission.'
    };
  }

  const message = asErrorMessage(error, 'Packetization failed.');
  return {
    title: `Error: packetization failed: ${message}`,
    warning: 'Adjust settings and retry transmission.'
  };
}

export function validateFileBeforeTransmission(file: BrowserFileLike): SenderFailure | null {
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return {
      title: 'File too large',
      warning: 'Large files may take a very long time and may fail more often.'
    };
  }
  return null;
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export async function encodeFrameToCanvas(
  frame: TransferFrame,
  qrCanvas: HTMLCanvasElement,
  options: { qrPrefix: string; qrErrorCorrection: QRCode.QRCodeErrorCorrectionLevel; qrSizePx: number },
  deps: { toCanvas: typeof QRCode.toCanvas } = { toCanvas: QRCode.toCanvas }
): Promise<void> {
  try {
    const payload = `${options.qrPrefix}${bytesToBase64(assembleFrame(frame))}`;
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

export function frameLabel(frame: TransferFrame, totalDataPackets: number): string {
  return frame.frameType === FRAME_TYPE_DATA ? `packet ${frame.packetIndex + 1}/${totalDataPackets}` : 'meta';
}
