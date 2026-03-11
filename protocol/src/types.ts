export const MAGIC_BYTES = new Uint8Array([0x51, 0x52, 0x42, 0x47]); // QRBG
export const PROTOCOL_VERSION = 0x01;
export const HEADER_SIZE = 13;
export const CHECKSUM_SIZE = 4;

export interface Packet {
  version: number;
  fileHash: number;
  totalPackets: number;
  packetIndex: number;
  payload: Uint8Array;
  packetChecksum: number;
}
