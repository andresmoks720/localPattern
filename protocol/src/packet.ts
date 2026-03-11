import { calculateCRC32 } from './crc32';
import { BASE_HEADER_SIZE, CHECKSUM_SIZE, MAGIC_BYTES, PROTOCOL_VERSION, type ChunkFileOptions, type Packet } from './types';

export const DEFAULT_MAX_PAYLOAD_SIZE = 512;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function assertUint16(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`${fieldName} must be a uint16.`);
  }
}

function fileNameBytes(fileName: string): Uint8Array {
  const encoded = textEncoder.encode(fileName.trim() || 'unnamed.bin');
  if (encoded.length > 0xff) {
    throw new Error('fileName must be <= 255 UTF-8 bytes.');
  }
  return encoded;
}

function packetHeaderBytes(packet: Omit<Packet, 'packetChecksum'>): Uint8Array {
  assertUint16(packet.totalPackets, 'totalPackets');
  assertUint16(packet.packetIndex, 'packetIndex');

  const encodedFileName = fileNameBytes(packet.fileName);
  const headerAndPayload = new Uint8Array(BASE_HEADER_SIZE + encodedFileName.length + packet.payload.length);
  const view = new DataView(headerAndPayload.buffer, headerAndPayload.byteOffset, headerAndPayload.byteLength);

  headerAndPayload.set(MAGIC_BYTES, 0);
  view.setUint8(4, packet.version);
  view.setUint32(5, packet.fileHash);
  view.setUint16(9, packet.totalPackets);
  view.setUint16(11, packet.packetIndex);
  view.setUint8(13, encodedFileName.length);
  headerAndPayload.set(encodedFileName, BASE_HEADER_SIZE);
  headerAndPayload.set(packet.payload, BASE_HEADER_SIZE + encodedFileName.length);

  return headerAndPayload;
}

export function assemblePacket(packet: Packet): Uint8Array {
  const headerAndPayload = packetHeaderBytes(packet);
  const computedChecksum = calculateCRC32(headerAndPayload);

  if (packet.packetChecksum !== computedChecksum) {
    throw new Error('packetChecksum mismatch for packet content.');
  }

  const bytes = new Uint8Array(headerAndPayload.length + CHECKSUM_SIZE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  bytes.set(headerAndPayload, 0);
  view.setUint32(headerAndPayload.length, packet.packetChecksum);

  return bytes;
}

export function parsePacket(packetBytes: Uint8Array): Packet {
  if (packetBytes.length < BASE_HEADER_SIZE + CHECKSUM_SIZE) {
    throw new Error('Packet is too small.');
  }

  if (!MAGIC_BYTES.every((byte, index) => packetBytes[index] === byte)) {
    throw new Error('Invalid packet magic bytes.');
  }

  const view = new DataView(packetBytes.buffer, packetBytes.byteOffset, packetBytes.byteLength);
  const version = view.getUint8(4);

  if (version !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported protocol version: ${version}`);
  }

  const fileHash = view.getUint32(5);
  const totalPackets = view.getUint16(9);
  const packetIndex = view.getUint16(11);
  const fileNameLength = view.getUint8(13);

  const payloadStart = BASE_HEADER_SIZE + fileNameLength;
  const payloadEnd = packetBytes.length - CHECKSUM_SIZE;

  if (payloadStart > payloadEnd) {
    throw new Error('Malformed packet payload offsets.');
  }

  const fileName = textDecoder.decode(packetBytes.slice(BASE_HEADER_SIZE, payloadStart));
  const payload = packetBytes.slice(payloadStart, payloadEnd);
  const packetChecksum = view.getUint32(payloadEnd);

  const packet: Packet = {
    version,
    fileHash,
    totalPackets,
    packetIndex,
    fileName,
    payload,
    packetChecksum
  };

  const reassembled = assemblePacket(packet);
  const checksumReadback = new DataView(reassembled.buffer, reassembled.byteOffset, reassembled.byteLength).getUint32(
    reassembled.length - CHECKSUM_SIZE
  );

  if (checksumReadback !== packetChecksum) {
    throw new Error('Packet checksum validation failed.');
  }

  return packet;
}

export function chunkFile(file: Uint8Array, options: ChunkFileOptions = {}): Packet[] {
  const maxPayloadSize = options.maxPayloadSize ?? DEFAULT_MAX_PAYLOAD_SIZE;
  if (maxPayloadSize <= 0 || !Number.isInteger(maxPayloadSize)) {
    throw new Error('maxPayloadSize must be a positive integer.');
  }

  const normalizedFileName = options.fileName?.trim() || 'unnamed.bin';
  const fileHash = calculateCRC32(file);
  const totalPackets = Math.max(1, Math.ceil(file.length / maxPayloadSize));
  assertUint16(totalPackets, 'totalPackets');

  const packets: Packet[] = [];

  for (let packetIndex = 0; packetIndex < totalPackets; packetIndex += 1) {
    const start = packetIndex * maxPayloadSize;
    const end = Math.min(start + maxPayloadSize, file.length);
    const payload = file.slice(start, end);

    const draftPacket: Omit<Packet, 'packetChecksum'> = {
      version: PROTOCOL_VERSION,
      fileHash,
      totalPackets,
      packetIndex,
      fileName: normalizedFileName,
      payload
    };

    const packetChecksum = calculateCRC32(packetHeaderBytes(draftPacket));

    packets.push({
      ...draftPacket,
      packetChecksum
    });
  }

  return packets;
}
