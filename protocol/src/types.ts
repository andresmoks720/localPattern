export const MAGIC_BYTES = new Uint8Array([0x51, 0x44, 0x42, 0x32]); // QDB2
export const LEGACY_MAGIC_BYTES = new Uint8Array([0x51, 0x44, 0x42, 0x31]); // QDB1
export const PROTOCOL_VERSION = '2.0.0';

export const FRAME_TYPE_HEADER = 0x01;
export const FRAME_TYPE_DATA = 0x02;
export const FRAME_TYPE_END = 0x03;

export interface TransferHeaderFrame {
  frameType: typeof FRAME_TYPE_HEADER;
  transferId: Uint8Array;
  fileName: string;
  fileSize: number;
  totalPackets: number;
  fileCrc32: number;
}

export interface TransferDataFrame {
  frameType: typeof FRAME_TYPE_DATA;
  transferId: Uint8Array;
  packetIndex: number;
  payload: Uint8Array;
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
