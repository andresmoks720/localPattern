import { describe, expect, it } from 'vitest';
import { FRAME_TYPE_DATA, FRAME_TYPE_END, FRAME_TYPE_HEADER, type TransferEndFrame, type TransferHeaderFrame } from './types';
import { assembleFrame, chunkFile, parseFrame } from './packet';
import { calculateCRC32 } from './crc32';

function transferId(): Uint8Array {
  return new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
}

describe('protocol framing', () => {
  it('HEADER roundtrip parse/assemble', () => {
    const header: TransferHeaderFrame = {
      frameType: FRAME_TYPE_HEADER,
      transferId: transferId(),
      fileName: 'demo.bin',
      fileSize: 100,
      totalPackets: 2,
      fileCrc32: 123456
    };
    const parsed = parseFrame(assembleFrame(header));
    expect(parsed).toEqual(header);
  });

  it('DATA roundtrip parse/assemble with transferId', () => {
    const payload = new Uint8Array([9, 8, 7, 6]);
    const transfer = chunkFile(payload, { transferId: transferId(), includeEndFrame: true, maxPayloadSize: 2 });
    const data = transfer.dataFrames[0];
    const parsed = parseFrame(assembleFrame(data));
    expect(parsed.frameType).toBe(FRAME_TYPE_DATA);
    if (parsed.frameType !== FRAME_TYPE_DATA) throw new Error('expected data');
    expect(parsed.transferId).toEqual(transfer.header.transferId);
    expect(parsed.packetIndex).toBe(0);
  });

  it('END roundtrip parse/assemble', () => {
    const end: TransferEndFrame = { frameType: FRAME_TYPE_END, transferId: transferId() };
    const parsed = parseFrame(assembleFrame(end));
    expect(parsed).toEqual(end);
  });

  it('DATA CRC32 mismatch rejected', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const transfer = chunkFile(payload, { transferId: transferId(), includeEndFrame: true, maxPayloadSize: 2 });
    const bad = { ...transfer.dataFrames[0], packetCrc32: 1 };
    expect(() => assembleFrame(bad)).toThrow(/packetCrc32 mismatch/i);
  });



  it('full-file CRC32 mismatch rejected', () => {
    const source = new Uint8Array([10, 20, 30, 40]);
    const transfer = chunkFile(source, { transferId: transferId(), maxPayloadSize: 2 });
    const tampered = source.slice();
    tampered[0] = 99;
    expect(calculateCRC32(tampered)).not.toBe(transfer.header.fileCrc32);
  });

  it('wrong protocol magic/version rejected', () => {
    const wrongMagic = new Uint8Array([0, 0, 0, 0, FRAME_TYPE_END]);
    expect(() => parseFrame(wrongMagic)).toThrow(/Invalid frame magic bytes/);

    const legacy = new Uint8Array([0x51, 0x44, 0x42, 0x31, FRAME_TYPE_END]);
    expect(() => parseFrame(legacy)).toThrow(/Version Mismatch/);
  });


  it('full packet set + matching CRC can be reassembled', () => {
    const source = new Uint8Array([10, 20, 30, 40, 50]);
    const transfer = chunkFile(source, { transferId: transferId(), maxPayloadSize: 2 });
    const pieces: Uint8Array[] = [];
    for (const frame of transfer.dataFrames) {
      const parsed = parseFrame(assembleFrame(frame));
      if (parsed.frameType !== FRAME_TYPE_DATA) throw new Error('expected data');
      pieces.push(parsed.payload);
    }
    const combined = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of pieces) {
      combined.set(p, offset);
      offset += p.length;
    }
    expect(combined).toEqual(source);
    expect(transfer.header.fileCrc32).toBeDefined();
  });

  it('transferId required and validated for DATA', () => {
    const payload = new Uint8Array([1, 2]);
    const transfer = chunkFile(payload, { transferId: transferId(), maxPayloadSize: 2 });
    const bad = { ...transfer.dataFrames[0], transferId: new Uint8Array([1, 2, 3]) };
    expect(() => assembleFrame(bad)).toThrow(/transferId must be exactly 8 bytes/);
  });
});
