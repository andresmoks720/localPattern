import { describe, expect, it, vi } from 'vitest';
import { ProtocolError } from '@qr-data-bridge/protocol';
import {
  MAX_FILE_SIZE_BYTES,
  buildTransmissionFrames,
  encodeFrameToCanvas,
  estimateTransmissionDurationMs,
  getFrameDisplayDurationMs,
  HEADER_HOLD_MS,
  END_HOLD_MS,
  FIXED_DATA_FRAME_DURATION_MS,
  preflightEncodeFrames,
  readFileBytes,
  toUserFacingSenderError,
  validateFileBeforeTransmission,
  type BrowserFileLike
} from './senderCore';

describe('sender core', () => {
  it('rejects files larger than 1 MiB before transmission', () => {
    const file: BrowserFileLike = {
      name: 'big.bin',
      size: MAX_FILE_SIZE_BYTES + 1,
      arrayBuffer: async () => new ArrayBuffer(0)
    };

    const result = validateFileBeforeTransmission(file);
    expect(result?.title).toBe('File too large');
    expect(result?.warning).toBe('Large files may take a very long time and may fail more often.');
  });

  it('surfaces file read failures as user-visible errors', async () => {
    const file: BrowserFileLike = {
      name: 'broken.bin',
      size: 32,
      arrayBuffer: async () => {
        throw new Error('disk read failed');
      }
    };

    await expect(readFileBytes(file)).rejects.toThrow('Error: file read failed: disk read failed');
  });

  it('maps packetization failures to user-facing packetization errors', () => {
    try {
      buildTransmissionFrames(new Uint8Array([1, 2, 3]), 'ok.bin', 0);
      throw new Error('expected to fail');
    } catch (error) {
      const mapped = toUserFacingSenderError(error);
      expect(mapped.title.startsWith('Error: packetization failed:')).toBe(true);
      expect(mapped.warning).toContain('Adjust settings and retry transmission.');
      expect(error).toBeInstanceOf(ProtocolError);
    }
  });

  it('surfaces QR encode failure as user-visible error', async () => {
    const { frames } = buildTransmissionFrames(new Uint8Array([1, 2, 3]), 'ok.bin', 512);
    const canvas = {} as HTMLCanvasElement;

    await expect(
      encodeFrameToCanvas(
        frames[0],
        canvas,
        { qrPrefix: 'QDB64:', qrErrorCorrection: 'H', qrSizePx: 400 },
        { toCanvas: async () => { throw new Error('encode exploded'); } }
      )
    ).rejects.toThrow('Error: QR encode failed: encode exploded');
  });

  it('fails preflight when any frame cannot be encoded', async () => {
    const { frames } = buildTransmissionFrames(new Uint8Array([1, 2, 3]), 'ok.bin', 2);
    vi.stubGlobal('document', { createElement: () => ({}) });
    const toCanvas = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('too dense'));

    await expect(
      preflightEncodeFrames(frames, { qrPrefix: 'QDB64:', qrErrorCorrection: 'H', qrSizePx: 400 }, { toCanvas })
    ).rejects.toThrow('Error: frame precompute failed: Error: QR encode failed: too dense');
    vi.unstubAllGlobals();
  });

  it('generates a fresh transferId on each build attempt', () => {
    const first = buildTransmissionFrames(new Uint8Array([1, 2, 3]), 'same.bin', 2);
    const second = buildTransmissionFrames(new Uint8Array([1, 2, 3]), 'same.bin', 2);

    const firstHeader = first.frames[0];
    const secondHeader = second.frames[0];
    if (firstHeader.frameType !== 0x01 || secondHeader.frameType !== 0x01) {
      throw new Error('unexpected header frame type');
    }

    expect(Array.from(firstHeader.transferId)).not.toEqual(Array.from(secondHeader.transferId));
  });

  it('uses fixed frame durations with control-frame holds', () => {
    const { frames } = buildTransmissionFrames(new Uint8Array([1, 2, 3, 4]), 'dur.bin', 2);
    expect(getFrameDisplayDurationMs(frames[0])).toBe(HEADER_HOLD_MS);
    expect(getFrameDisplayDurationMs(frames[1])).toBe(FIXED_DATA_FRAME_DURATION_MS);
    expect(getFrameDisplayDurationMs(frames[2])).toBe(FIXED_DATA_FRAME_DURATION_MS);
    expect(getFrameDisplayDurationMs(frames[3])).toBe(END_HOLD_MS);
    expect(estimateTransmissionDurationMs(frames)).toBe(HEADER_HOLD_MS + FIXED_DATA_FRAME_DURATION_MS + FIXED_DATA_FRAME_DURATION_MS + END_HOLD_MS);
  });

  it('maps overlong filename to filename limit sender error bucket', () => {
    try {
      buildTransmissionFrames(new Uint8Array([1]), 'a'.repeat(65536), 512);
      throw new Error('expected filename to fail');
    } catch (error) {
      const mapped = toUserFacingSenderError(error);
      expect(mapped.title.startsWith('Error: filename limit exceeded:')).toBe(true);
      expect(mapped.warning).toContain('Rename the file to a shorter UTF-8 name and try again.');
      expect(error).toBeInstanceOf(ProtocolError);
    }
  });

});
