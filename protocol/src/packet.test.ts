import { describe, expect, it } from 'vitest';
import {
  FRAME_TYPE_DATA,
  FRAME_TYPE_END,
  FRAME_TYPE_HEADER,
  PROTOCOL_ERROR_CODES,
  ProtocolError,
  assembleFrame,
  chunkFile,
  parseFrame,
  type TransferDataFrame,
  type TransferEndFrame,
  type TransferHeaderFrame
} from './index';

describe('protocol frame assembly/parsing', () => {
  const transferId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  it('HEADER roundtrip parse/assemble', () => {
    const frame: TransferHeaderFrame = {
      frameType: FRAME_TYPE_HEADER,
      transferId,
      fileName: 'example.txt',
      fileSize: 10,
      totalPackets: 1,
      fileCrc32: 0
    };

    const parsed = parseFrame(assembleFrame(frame));
    expect(parsed.frameType).toBe(FRAME_TYPE_HEADER);
    if (parsed.frameType !== FRAME_TYPE_HEADER) throw new Error('unexpected frame type');
    expect(parsed.fileName).toBe('example.txt');
  });

  it('DATA roundtrip parse/assemble', () => {
    const payload = new Uint8Array([10, 11, 12]);
    const transfer = chunkFile(payload, { fileName: 'a.bin', transferId, includeEndFrame: true, maxPayloadSize: 16 });
    const parsed = parseFrame(assembleFrame(transfer.dataFrames[0]));
    expect(parsed.frameType).toBe(FRAME_TYPE_DATA);
    if (parsed.frameType !== FRAME_TYPE_DATA) throw new Error('unexpected frame type');
    expect(parsed.packetIndex).toBe(0);
    expect(parsed.payload).toEqual(payload);
  });

  it('END roundtrip parse/assemble', () => {
    const frame: TransferEndFrame = { frameType: FRAME_TYPE_END, transferId };
    const parsed = parseFrame(assembleFrame(frame));
    expect(parsed.frameType).toBe(FRAME_TYPE_END);
  });

  it('rejects invalid magic/version', () => {
    const badMagic = new Uint8Array([0, 0, 0, 0, FRAME_TYPE_END, 0x02, ...transferId]);
    expect(() => parseFrame(badMagic)).toThrowError(ProtocolError);
    try {
      parseFrame(badMagic);
    } catch (error) {
      expect((error as ProtocolError).code).toBe(PROTOCOL_ERROR_CODES.INVALID_MAGIC);
    }
  });

  it('rejects empty filename with structured code', () => {
    expect(() => chunkFile(new Uint8Array([1]), { fileName: '   ' })).toThrowError(ProtocolError);
    try {
      chunkFile(new Uint8Array([1]), { fileName: '   ' });
    } catch (error) {
      expect((error as ProtocolError).code).toBe(PROTOCOL_ERROR_CODES.INVALID_FILE_NAME);
    }
  });

  it('rejects data crc mismatch with structured code', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const badFrame: TransferDataFrame = {
      frameType: FRAME_TYPE_DATA,
      transferId,
      packetIndex: 0,
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
});
