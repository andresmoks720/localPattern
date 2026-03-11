import { describe, expect, it } from 'vitest';
import { ProtocolError } from '@qr-data-bridge/protocol';
import {
  MAX_FILE_SIZE_BYTES,
  buildTransmissionFrames,
  encodeFrameToCanvas,
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
});
