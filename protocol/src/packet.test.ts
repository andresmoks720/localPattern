import { describe, expect, it } from 'vitest';
import {
  FRAME_TYPE_DATA,
  FRAME_TYPE_END,
  FRAME_TYPE_HEADER,
  PROTOCOL_ERROR_CODES,
  ProtocolError,
  assembleFrame,
  calculateCRC32,
  chunkFile,
  parseFrame,
  type TransferDataFrame,
  type TransferEndFrame,
  type TransferHeaderFrame
} from './index';

describe('protocol frame assembly/parsing', () => {
  const transferId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  it('HEADER roundtrip parse/assemble with headerCrc32', () => {
    const transfer = chunkFile(new Uint8Array([1, 2, 3]), { fileName: 'example.txt', transferId, includeEndFrame: true, maxPayloadSize: 16 });
    const parsed = parseFrame(assembleFrame(transfer.header));
    expect(parsed.frameType).toBe(FRAME_TYPE_HEADER);
    if (parsed.frameType !== FRAME_TYPE_HEADER) throw new Error('unexpected frame type');
    expect(parsed.fileName).toBe('example.txt');
    expect(parsed.headerCrc32).toBe(transfer.header.headerCrc32);
  });

  it('DATA roundtrip parse/assemble with payloadLen', () => {
    const payload = new Uint8Array([10, 11, 12]);
    const transfer = chunkFile(payload, { fileName: 'a.bin', transferId, includeEndFrame: true, maxPayloadSize: 16 });
    const parsed = parseFrame(assembleFrame(transfer.dataFrames[0]));
    expect(parsed.frameType).toBe(FRAME_TYPE_DATA);
    if (parsed.frameType !== FRAME_TYPE_DATA) throw new Error('unexpected frame type');
    expect(parsed.packetIndex).toBe(0);
    expect(parsed.payloadLen).toBe(3);
    expect(parsed.payload).toEqual(payload);
  });

  it('END roundtrip parse/assemble', () => {
    const frame: TransferEndFrame = { frameType: FRAME_TYPE_END, transferId };
    const parsed = parseFrame(assembleFrame(frame));
    expect(parsed.frameType).toBe(FRAME_TYPE_END);
  });

  it('rejects invalid magic and legacy magic', () => {
    const badMagic = new Uint8Array([0, 0, 0, 0, FRAME_TYPE_END, ...transferId]);
    expect(() => parseFrame(badMagic)).toThrowError(ProtocolError);
    try {
      parseFrame(badMagic);
    } catch (error) {
      expect((error as ProtocolError).code).toBe(PROTOCOL_ERROR_CODES.INVALID_MAGIC);
    }

    const legacyMagic = new Uint8Array([0x51, 0x44, 0x42, 0x31, FRAME_TYPE_END, ...transferId]);
    expect(() => parseFrame(legacyMagic)).toThrowError(ProtocolError);
    try {
      parseFrame(legacyMagic);
    } catch (error) {
      expect((error as ProtocolError).code).toBe(PROTOCOL_ERROR_CODES.VERSION_MISMATCH);
    }
  });

  it('rejects malformed DATA with payloadLen mismatch/trailing bytes', () => {
    const transfer = chunkFile(new Uint8Array([1, 2, 3]), { fileName: 'x.bin', transferId, maxPayloadSize: 16, includeEndFrame: true });
    const bytes = assembleFrame(transfer.dataFrames[0]);
    const malformed = new Uint8Array(bytes.length + 1);
    malformed.set(bytes, 0);
    malformed[15] = 0; // payloadLen high
    malformed[16] = 2; // payloadLen low (claims 2)
    malformed[malformed.length - 1] = 0xff; // trailing noise

    expect(() => parseFrame(malformed)).toThrowError(ProtocolError);
    try {
      parseFrame(malformed);
    } catch (error) {
      expect((error as ProtocolError).code).toBe(PROTOCOL_ERROR_CODES.MALFORMED_DATA);
    }
  });

  it('enforces packet CRC coverage transferId+packetIndex+payload', () => {
    const transfer = chunkFile(new Uint8Array([1, 2, 3]), { fileName: 'x.bin', transferId, maxPayloadSize: 16, includeEndFrame: true });
    const frame = transfer.dataFrames[0];

    const badTransferIdFrame: TransferDataFrame = {
      ...frame,
      transferId: new Uint8Array([9, 2, 3, 4, 5, 6, 7, 8]),
      payloadLen: frame.payload.length
    };

    expect(() => assembleFrame(badTransferIdFrame)).toThrowError(ProtocolError);
    try {
      assembleFrame(badTransferIdFrame);
    } catch (error) {
      expect((error as ProtocolError).code).toBe(PROTOCOL_ERROR_CODES.PACKET_CRC_MISMATCH);
    }
  });

  it('supports zero-byte transfer contract (HEADER->END only)', () => {
    const transfer = chunkFile(new Uint8Array(), { fileName: 'empty.bin', transferId, includeEndFrame: true });
    expect(transfer.header.totalPackets).toBe(0);
    expect(transfer.dataFrames).toHaveLength(0);
    expect(transfer.endFrame).toBeDefined();
  });

  it('crc32 empty input is 0x00000000', () => {
    expect(calculateCRC32(new Uint8Array())).toBe(0x00000000);
  });

  it('rejects header crc mismatch', () => {
    const transfer = chunkFile(new Uint8Array([1]), { fileName: 'x.bin', transferId, includeEndFrame: true });
    const badHeader: TransferHeaderFrame = {
      ...transfer.header,
      headerCrc32: (transfer.header.headerCrc32 + 1) >>> 0
    };

    expect(() => assembleFrame(badHeader)).toThrowError(ProtocolError);
    try {
      assembleFrame(badHeader);
    } catch (error) {
      expect((error as ProtocolError).code).toBe(PROTOCOL_ERROR_CODES.HEADER_CRC_MISMATCH);
    }
  });

  it('rejects data crc mismatch with structured code', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const badFrame: TransferDataFrame = {
      frameType: FRAME_TYPE_DATA,
      transferId,
      packetIndex: 0,
      payloadLen: payload.length,
      payload,
      packetCrc32: 1
    };

    expect(() => assembleFrame(badFrame)).toThrowError(ProtocolError);
    try {
      assembleFrame(badFrame);
    } catch (error) {
      expect((error as ProtocolError).code).toBe(PROTOCOL_ERROR_CODES.PACKET_CRC_MISMATCH);
    }
  });

  it('matches exact END byte layout', () => {
    const frame: TransferEndFrame = { frameType: FRAME_TYPE_END, transferId };
    const bytes = assembleFrame(frame);

    expect(bytes.length).toBe(13);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x51, 0x44, 0x42, 0x32]);
    expect(bytes[4]).toBe(FRAME_TYPE_END);
    expect(Array.from(bytes.slice(5, 13))).toEqual(Array.from(transferId));
  });

  it('matches exact DATA byte layout offsets', () => {
    const payload = new Uint8Array([0xaa, 0xbb]);
    const transfer = chunkFile(payload, { fileName: 'x.bin', transferId, maxPayloadSize: 2, includeEndFrame: true });
    const bytes = assembleFrame(transfer.dataFrames[0]);

    expect(bytes[4]).toBe(FRAME_TYPE_DATA);
    expect(Array.from(bytes.slice(5, 13))).toEqual(Array.from(transferId));
    expect((bytes[13] << 8) | bytes[14]).toBe(0); // packetIndex
    expect((bytes[15] << 8) | bytes[16]).toBe(2); // payloadLen
    expect(Array.from(bytes.slice(17, 19))).toEqual([0xaa, 0xbb]);
    expect(bytes.length).toBe(23);
  });

  it('enforces filename byte boundary length limits', () => {
    const maxName = 'a'.repeat(65535);
    expect(() => chunkFile(new Uint8Array([1]), { fileName: maxName, maxPayloadSize: 512 })).not.toThrow();

    const tooLong = 'a'.repeat(65536);
    expect(() => chunkFile(new Uint8Array([1]), { fileName: tooLong, maxPayloadSize: 512 })).toThrowError(ProtocolError);
  });

  it('supports multibyte utf-8 filename boundaries', () => {
    const valid = 'é'.repeat(Math.floor(65535 / 2));
    expect(() => chunkFile(new Uint8Array([1]), { fileName: valid, maxPayloadSize: 512 })).not.toThrow();

    const invalid = '€'.repeat(21846); // 65538 bytes
    expect(() => chunkFile(new Uint8Array([1]), { fileName: invalid, maxPayloadSize: 512 })).toThrowError(ProtocolError);
  });

  it('requires transferId to be exactly 8 bytes across frames', () => {
    const badId = new Uint8Array([1, 2, 3]);

    const header: TransferHeaderFrame = {
      frameType: FRAME_TYPE_HEADER,
      transferId: badId,
      fileName: 'a.bin',
      fileSize: 1,
      totalPackets: 1,
      fileCrc32: 0,
      headerCrc32: 0
    };

    const data: TransferDataFrame = {
      frameType: FRAME_TYPE_DATA,
      transferId: badId,
      packetIndex: 0,
      payloadLen: 1,
      payload: new Uint8Array([1]),
      packetCrc32: 0
    };

    const end: TransferEndFrame = {
      frameType: FRAME_TYPE_END,
      transferId: badId
    };

    expect(() => assembleFrame(header)).toThrowError(ProtocolError);
    expect(() => assembleFrame(data)).toThrowError(ProtocolError);
    expect(() => assembleFrame(end)).toThrowError(ProtocolError);
  });

});
