import { beforeEach, describe, expect, it } from 'vitest';
import { DecodePipeline, type DecodePipelineConfig, type DecodeTrackingHint } from './DecodePipeline';
import type { DecodeResult, ReceiverFrameDecoder } from './ReceiverFrameDecoder';

class ScriptedDecoder implements ReceiverFrameDecoder {
  public constructor(private readonly script: Array<DecodeResult | null>) {}

  public decode(): DecodeResult | null {
    return this.script.shift() ?? null;
  }
}

type FakeCanvas = {
  width: number;
  height: number;
  getContext: () => {
    drawImage: () => void;
    getImageData: (_x: number, _y: number, width: number, height: number) => { data: Uint8ClampedArray };
  };
};

function createFakeCanvas(width = 640, height = 480): FakeCanvas {
  return {
    width,
    height,
    getContext: () => ({
      drawImage: () => undefined,
      getImageData: (_x, _y, targetWidth, targetHeight) => ({ data: new Uint8ClampedArray(targetWidth * targetHeight * 4) })
    })
  };
}

function config(overrides: Partial<DecodePipelineConfig> = {}): DecodePipelineConfig {
  return {
    roiPaddingRatio: 0.4,
    roiMissesBeforeFull: 3,
    forceFullEveryAttempts: 10,
    noSuccessResetMs: 1000,
    maxFullSidePx: 640,
    maxRoiSidePx: 640,
    ...overrides
  };
}

const withGeometry: DecodeResult = {
  payload: new Uint8Array([1, 2, 3]),
  geometry: {
    corners: [
      { x: 100, y: 100 },
      { x: 200, y: 100 },
      { x: 200, y: 200 },
      { x: 100, y: 200 }
    ]
  }
};

beforeEach(() => {
  const scratch = createFakeCanvas();
  (globalThis as unknown as { document?: { createElement: (_tag: string) => FakeCanvas } }).document = {
    createElement: () => scratch
  };
});

function accept(pipeline: DecodePipeline, hint: DecodeTrackingHint, nowMs: number, activeTransferId: string | null, frameTransferId: string): void {
  pipeline.noteSuccessfulProtocolDecode(
    hint,
    {
      lockConfirmed: true,
      activeTransferId,
      frameTransferId
    },
    nowMs
  );
}

describe('DecodePipeline', () => {
  it('stays full-frame before lock (no ROI path)', () => {
    const decoder = new ScriptedDecoder([withGeometry, withGeometry]);
    const pipeline = new DecodePipeline(decoder, config());
    const canvas = createFakeCanvas();

    const first = pipeline.decode(canvas as unknown as HTMLCanvasElement, 640, 480, false, 0);
    const second = pipeline.decode(canvas as unknown as HTMLCanvasElement, 640, 480, false, 50);

    expect(first.mode).toBe('full');
    expect(second.mode).toBe('full');
    expect(first.trackingHint.sourceRegion).toEqual({ x: 0, y: 0, width: 640, height: 480 });
    expect(second.trackingHint.sourceRegion).toEqual({ x: 0, y: 0, width: 640, height: 480 });
  });

  it('updates ROI only after protocol-accepted decode note', () => {
    const decoder = new ScriptedDecoder([withGeometry, null, withGeometry, null]);
    const pipeline = new DecodePipeline(decoder, config());
    const canvas = createFakeCanvas();

    const rawOnly = pipeline.decode(canvas as unknown as HTMLCanvasElement, 640, 480, true, 0);
    expect(rawOnly.mode).toBe('full');

    const noProtocolNote = pipeline.decode(canvas as unknown as HTMLCanvasElement, 640, 480, true, 50);
    expect(noProtocolNote.mode).toBe('full');

    const protocolValid = pipeline.decode(canvas as unknown as HTMLCanvasElement, 640, 480, true, 100);
    accept(pipeline, protocolValid.trackingHint, 100, null, 'aaaa');

    const roiAttempt = pipeline.decode(canvas as unknown as HTMLCanvasElement, 640, 480, true, 150);
    expect(roiAttempt.mode).toBe('roi');
  });

  it('does not update ROI from foreign transfer frames when locked', () => {
    const decoder = new ScriptedDecoder([withGeometry, null, withGeometry, null]);
    const pipeline = new DecodePipeline(decoder, config());
    const canvas = createFakeCanvas();

    const first = pipeline.decode(canvas as unknown as HTMLCanvasElement, 640, 480, true, 0);
    accept(pipeline, first.trackingHint, 0, 'active-id', 'active-id');

    const roiAttempt = pipeline.decode(canvas as unknown as HTMLCanvasElement, 640, 480, true, 50);
    expect(roiAttempt.mode).toBe('roi');

    const foreign = pipeline.decode(canvas as unknown as HTMLCanvasElement, 640, 480, true, 100);
    accept(pipeline, foreign.trackingHint, 100, 'active-id', 'other-id');

    pipeline.resetForFreshAttempt();
    const freshAfterReset = pipeline.decode(canvas as unknown as HTMLCanvasElement, 640, 480, true, 150);
    expect(freshAfterReset.mode).toBe('full');
  });

  it('falls back to full after configured ROI misses and periodic schedule', () => {
    const decoder = new ScriptedDecoder([withGeometry, null, null, null, null, null]);
    const pipeline = new DecodePipeline(decoder, config({ forceFullEveryAttempts: 99, roiMissesBeforeFull: 3 }));
    const canvas = createFakeCanvas();

    const first = pipeline.decode(canvas as unknown as HTMLCanvasElement, 640, 480, true, 0);
    accept(pipeline, first.trackingHint, 0, null, 'a');

    const roiMiss = pipeline.decode(canvas as unknown as HTMLCanvasElement, 640, 480, true, 20);
    const secondMiss = pipeline.decode(canvas as unknown as HTMLCanvasElement, 640, 480, true, 40);
    const thirdMiss = pipeline.decode(canvas as unknown as HTMLCanvasElement, 640, 480, true, 60);
    const missThresholdFallback = pipeline.decode(canvas as unknown as HTMLCanvasElement, 640, 480, true, 80);

    expect(roiMiss.mode).toBe('roi');
    expect(secondMiss.mode).toBe('roi');
    expect(thirdMiss.mode).toBe('roi');
    expect(missThresholdFallback.mode).toBe('full');
  });



  it('forces periodic full-frame decode while ROI mode is active', () => {
    const decoder = new ScriptedDecoder([withGeometry, null, null, null]);
    const pipeline = new DecodePipeline(decoder, config({ forceFullEveryAttempts: 2, roiMissesBeforeFull: 99 }));
    const canvas = createFakeCanvas();

    const first = pipeline.decode(canvas as unknown as HTMLCanvasElement, 640, 480, true, 0);
    accept(pipeline, first.trackingHint, 0, null, 'a');

    const roiAttempt = pipeline.decode(canvas as unknown as HTMLCanvasElement, 640, 480, true, 20);
    const forcedFull = pipeline.decode(canvas as unknown as HTMLCanvasElement, 640, 480, true, 40);

    expect(roiAttempt.mode).toBe('roi');
    expect(forcedFull.mode).toBe('full');
  });

  it('forces full search after no protocol success timeout', () => {
    const decoder = new ScriptedDecoder([withGeometry, null, null]);
    const pipeline = new DecodePipeline(decoder, config({ noSuccessResetMs: 50 }));
    const canvas = createFakeCanvas();

    const first = pipeline.decode(canvas as unknown as HTMLCanvasElement, 640, 480, true, 0);
    accept(pipeline, first.trackingHint, 0, null, 'a');

    const roiMiss = pipeline.decode(canvas as unknown as HTMLCanvasElement, 640, 480, true, 20);
    expect(roiMiss.mode).toBe('roi');

    const stale = pipeline.decode(canvas as unknown as HTMLCanvasElement, 640, 480, true, 100);
    expect(stale.mode).toBe('full');
  });

  it('resets ROI and counters across lifecycle and long sessions', () => {
    const decoder = new ScriptedDecoder(new Array(500).fill(withGeometry));
    const pipeline = new DecodePipeline(decoder, config({ noSuccessResetMs: 100 }));
    const canvas = createFakeCanvas();

    for (let i = 0; i < 120; i += 1) {
      const attempt = pipeline.decode(canvas as unknown as HTMLCanvasElement, 640, 480, true, i * 10);
      if (attempt.decodeResult) {
        accept(pipeline, attempt.trackingHint, i * 10, null, 'id');
      }
    }
    expect(pipeline.getCounters().decodeAttempts).toBe(120);

    pipeline.resetForTerminalState();
    const postTerminal = pipeline.decode(canvas as unknown as HTMLCanvasElement, 640, 480, true, 2000);
    expect(postTerminal.mode).toBe('full');

    pipeline.resetForFreshAttempt();
    expect(pipeline.getCounters().decodeAttempts).toBe(0);
    const postFresh = pipeline.decode(canvas as unknown as HTMLCanvasElement, 640, 480, true, 2100);
    expect(postFresh.mode).toBe('full');
  });
});
