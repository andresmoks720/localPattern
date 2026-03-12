import { describe, expect, it, vi } from 'vitest';
import { ProtocolError } from '@qr-data-bridge/protocol';
import {
  LARGE_FILE_WARNING_BYTES,
  LARGE_FILE_WARNING_COPY,
  MAX_FILE_SIZE_BYTES,
  buildTransmissionFrames,
  encodeFrameToCanvas,
  estimateTransmissionDurationMs,
  getFrameDisplayDurationMs,
  getTransmissionWarnings,
  HEADER_HOLD_MS,
  END_HOLD_MS,
  FIXED_DATA_FRAME_DURATION_MS,
  preflightBuildFrameDataUrls,
  preflightEncodeFrames,
  readFileBytes,
  SENDER_ERROR_COPY_MAP,
  toUserFacingPreflightError,
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
    expect(result?.warning).toBe(LARGE_FILE_WARNING_COPY);
  });

  it('uses exact >512 KiB warning copy bucket from spec', () => {
    const warnings = getTransmissionWarnings(LARGE_FILE_WARNING_BYTES + 1, 5 * 60 * 1000);
    expect(warnings).toEqual([LARGE_FILE_WARNING_COPY]);
    expect(warnings[0]).toBe('Large files may take a long time and may fail more often.');
  });


  it('maps invalid preflight settings to dedicated user copy bucket', () => {
    const mapped = toUserFacingPreflightError(new Error('frame too dense for chosen QR size'));
    expect(mapped.title.startsWith(SENDER_ERROR_COPY_MAP.INVALID_PREFLIGHT_SETTINGS.titlePrefix)).toBe(true);
    expect(mapped.warning).toBe(SENDER_ERROR_COPY_MAP.INVALID_PREFLIGHT_SETTINGS.warning);
  });

  it('exposes complete sender error copy map entries', () => {
    expect(SENDER_ERROR_COPY_MAP.FILE_TOO_LARGE.title).toBe('File too large');
    expect(SENDER_ERROR_COPY_MAP.PACKETIZATION_FAILED.warning).toContain('Adjust settings');
    expect(SENDER_ERROR_COPY_MAP.FILENAME_LIMIT.warning).toContain('shorter UTF-8 name');
    expect(SENDER_ERROR_COPY_MAP.INVALID_PREFLIGHT_SETTINGS.warning).toContain('Adjust QR size');
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
        { qrErrorCorrection: 'H', qrSizePx: 400 },
        { toCanvas: async () => { throw new Error('encode exploded'); } }
      )
    ).rejects.toThrow('Error: QR encode failed: encode exploded');
  });


  it('precomputes frame image cache and returns one data URL per frame', async () => {
    const { frames } = buildTransmissionFrames(new Uint8Array([1, 2, 3]), 'ok.bin', 2);
    const fakeCanvas = { toDataURL: () => 'data:image/png;base64,abc' } as unknown as HTMLCanvasElement;
    vi.stubGlobal('document', { createElement: () => fakeCanvas });
    const toCanvas = vi.fn().mockResolvedValue(undefined);

    const urls = await preflightBuildFrameDataUrls(
      frames,
      { qrErrorCorrection: 'H', qrSizePx: 400 },
      { toCanvas }
    );

    expect(urls).toHaveLength(frames.length);
    expect(urls.every((u) => u.startsWith('data:image/png;base64,'))).toBe(true);
    vi.unstubAllGlobals();
  });

  it('builds fresh frame cache per attempt (no stale cache leakage)', async () => {
    let counter = 0;
    const fakeCanvas = { toDataURL: () => `data:image/png;base64,${counter++}` } as unknown as HTMLCanvasElement;
    vi.stubGlobal('document', { createElement: () => fakeCanvas });
    const toCanvas = vi.fn().mockResolvedValue(undefined);

    const first = await preflightBuildFrameDataUrls(
      buildTransmissionFrames(new Uint8Array([1, 2]), 'first.bin', 2).frames,
      { qrErrorCorrection: 'H', qrSizePx: 400 },
      { toCanvas }
    );

    const second = await preflightBuildFrameDataUrls(
      buildTransmissionFrames(new Uint8Array([9, 9, 9]), 'second.bin', 3).frames,
      { qrErrorCorrection: 'H', qrSizePx: 400 },
      { toCanvas }
    );

    expect(second[0]).not.toBe(first[0]);
    vi.unstubAllGlobals();
  });
  it('fails preflight when any frame cannot be encoded', async () => {
    const { frames } = buildTransmissionFrames(new Uint8Array([1, 2, 3]), 'ok.bin', 2);
    vi.stubGlobal('document', { createElement: () => ({}) });
    const toCanvas = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('too dense'));

    await expect(
      preflightEncodeFrames(frames, { qrErrorCorrection: 'H', qrSizePx: 400 }, { toCanvas })
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
