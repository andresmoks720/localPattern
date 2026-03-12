export const MAGIC_BYTES = new Uint8Array([0x51, 0x44, 0x42, 0x32]); // QDB2
export const LEGACY_MAGIC_BYTES = new Uint8Array([0x51, 0x44, 0x42, 0x31]); // QDB1
export const PROTOCOL_VERSION = '2.0.0';

export const FRAME_TYPE_HEADER = 0x01;
export const FRAME_TYPE_DATA = 0x02;
export const FRAME_TYPE_END = 0x03;


export const PROTOCOL_ERROR_CODES = {
  FRAME_TOO_SMALL: 'FRAME_TOO_SMALL',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  INVALID_MAGIC: 'INVALID_MAGIC',
  UNSUPPORTED_FRAME_TYPE: 'UNSUPPORTED_FRAME_TYPE',
  MALFORMED_HEADER: 'MALFORMED_HEADER',
  MALFORMED_DATA: 'MALFORMED_DATA',
  MALFORMED_END: 'MALFORMED_END',
  PACKET_CRC_MISMATCH: 'PACKET_CRC_MISMATCH',
  HEADER_CRC_MISMATCH: 'HEADER_CRC_MISMATCH',
  INVALID_TRANSFER_ID: 'INVALID_TRANSFER_ID',
  INVALID_UINT16: 'INVALID_UINT16',
  INVALID_UINT32: 'INVALID_UINT32',
  INVALID_MAX_PAYLOAD_SIZE: 'INVALID_MAX_PAYLOAD_SIZE',
  INVALID_FILE_NAME: 'INVALID_FILE_NAME',
  PACKET_BOUNDS: 'PACKET_BOUNDS',
  INVALID_TOTAL_PACKETS: 'INVALID_TOTAL_PACKETS',
  INVALID_PAYLOAD_LENGTH: 'INVALID_PAYLOAD_LENGTH'
} as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[keyof typeof PROTOCOL_ERROR_CODES];

export class ProtocolError extends Error {
  public readonly code: ProtocolErrorCode;

  public constructor(code: ProtocolErrorCode, message: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

export interface TransferHeaderFrame {
  frameType: typeof FRAME_TYPE_HEADER;
  transferId: Uint8Array;
  fileName: string;
  fileSize: number;
  totalPackets: number;
  fileCrc32: number;
  headerCrc32: number;
}

export interface TransferDataFrame {
  frameType: typeof FRAME_TYPE_DATA;
  transferId: Uint8Array;
  packetIndex: number;
  payload: Uint8Array;
  payloadLen: number;
  packetCrc32: number;
}

export interface TransferEndFrame {
  frameType: typeof FRAME_TYPE_END;
  transferId: Uint8Array;
}

export type TransferFrame = TransferHeaderFrame | TransferDataFrame | TransferEndFrame;

export interface ChunkFileOptions {
  maxPayloadSize?: number;
  fileName?: string;
  includeEndFrame?: boolean;
  transferId?: Uint8Array;
}

export interface ChunkedTransfer {
  header: TransferHeaderFrame;
  dataFrames: TransferDataFrame[];
  endFrame?: TransferEndFrame;
}
