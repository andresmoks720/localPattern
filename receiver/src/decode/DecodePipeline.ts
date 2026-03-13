import type { DecodeGeometry, DecodeResult, Point, ReceiverFrameDecoder } from './ReceiverFrameDecoder';

export interface DecodePipelineConfig {
  roiPaddingRatio: number;
  roiMissesBeforeFull: number;
  forceFullEveryAttempts: number;
  noSuccessResetMs: number;
  maxFullSidePx: number;
  maxRoiSidePx: number;
}

export type DecodeMode = 'full' | 'roi';

export interface DecodePipelineCounters {
  decodeAttempts: number;
  noQrFound: number;
  qrDetected: number;
  roiDecodeAttempts: number;
  roiDecodeSuccesses: number;
  fullDecodeAttempts: number;
  fullDecodeSuccesses: number;
  forcedFullFallbacks: number;
  roiResets: number;
  longestNoQrStreak: number;
  currentNoQrStreak: number;
}

interface RoiBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DecodeTrackingHint {
  mode: DecodeMode;
  geometry: DecodeGeometry | null;
  sourceRegion: RoiBox;
  inputWidth: number;
  inputHeight: number;
  frameWidth: number;
  frameHeight: number;
}

export interface DecodeAttemptResult {
  decodeResult: DecodeResult | null;
  mode: DecodeMode;
  inputWidth: number;
  inputHeight: number;
  trackingHint: DecodeTrackingHint;
}

export interface ProtocolAcceptance {
  lockConfirmed: boolean;
  activeTransferId: string | null;
  frameTransferId: string;
}

function createEmptyCounters(): DecodePipelineCounters {
  return {
    decodeAttempts: 0,
    noQrFound: 0,
    qrDetected: 0,
    roiDecodeAttempts: 0,
    roiDecodeSuccesses: 0,
    fullDecodeAttempts: 0,
    fullDecodeSuccesses: 0,
    forcedFullFallbacks: 0,
    roiResets: 0,
    longestNoQrStreak: 0,
    currentNoQrStreak: 0
  };
}

export class DecodePipeline {
  private roiBox: RoiBox | null = null;

  private lastSuccessAtMs: number | null = null;

  private consecutiveRoiMisses = 0;

  private attemptsSinceLastFull = 0;

  private readonly scratchCanvas = document.createElement('canvas');

  private readonly scratchContext: CanvasRenderingContext2D;

  private countersValue: DecodePipelineCounters = createEmptyCounters();

  public constructor(
    private readonly decoder: ReceiverFrameDecoder,
    private readonly config: DecodePipelineConfig
  ) {
    const context = this.scratchCanvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      throw new Error('Failed to initialize decode scratch context.');
    }
    this.scratchContext = context;
  }

  public resetForFreshAttempt(): void {
    this.clearRoi();
    this.lastSuccessAtMs = null;
    this.consecutiveRoiMisses = 0;
    this.attemptsSinceLastFull = 0;
    this.countersValue = createEmptyCounters();
  }

  public resetForTerminalState(): void {
    this.clearRoi();
    this.consecutiveRoiMisses = 0;
    this.attemptsSinceLastFull = 0;
  }

  public getCounters(): DecodePipelineCounters {
    return { ...this.countersValue };
  }

  public getMode(lockConfirmed: boolean, nowMs: number): DecodeMode {
    if (!lockConfirmed || !this.roiBox) return 'full';
    if (this.lastSuccessAtMs !== null && (nowMs - this.lastSuccessAtMs) > this.config.noSuccessResetMs) {
      this.countersValue.forcedFullFallbacks += 1;
      this.clearRoi();
      return 'full';
    }
    if (this.consecutiveRoiMisses >= this.config.roiMissesBeforeFull) {
      this.countersValue.forcedFullFallbacks += 1;
      this.attemptsSinceLastFull = this.config.forceFullEveryAttempts;
      return 'full';
    }
    if (this.attemptsSinceLastFull >= Math.max(1, this.config.forceFullEveryAttempts) - 1) {
      this.countersValue.forcedFullFallbacks += 1;
      return 'full';
    }
    return 'roi';
  }

  public decode(
    frameCanvas: HTMLCanvasElement,
    frameWidth: number,
    frameHeight: number,
    lockConfirmed: boolean,
    nowMs: number
  ): DecodeAttemptResult {
    const mode = this.getMode(lockConfirmed, nowMs);
    const sourceRegion = mode === 'roi' && this.roiBox
      ? this.clampBox(this.roiBox, frameWidth, frameHeight)
      : { x: 0, y: 0, width: frameWidth, height: frameHeight };
    const maxSide = mode === 'roi' ? this.config.maxRoiSidePx : this.config.maxFullSidePx;
    const scale = sourceRegion.width > 0 && sourceRegion.height > 0
      ? Math.min(1, maxSide / Math.max(sourceRegion.width, sourceRegion.height))
      : 1;
    const inputWidth = Math.max(1, Math.round(sourceRegion.width * scale));
    const inputHeight = Math.max(1, Math.round(sourceRegion.height * scale));

    this.scratchCanvas.width = inputWidth;
    this.scratchCanvas.height = inputHeight;
    this.scratchContext.drawImage(
      frameCanvas,
      sourceRegion.x,
      sourceRegion.y,
      sourceRegion.width,
      sourceRegion.height,
      0,
      0,
      inputWidth,
      inputHeight
    );

    const image = this.scratchContext.getImageData(0, 0, inputWidth, inputHeight);
    const decoded = this.decoder.decode(image.data, inputWidth, inputHeight);

    this.countersValue.decodeAttempts += 1;

    if (mode === 'roi') {
      this.countersValue.roiDecodeAttempts += 1;
      this.attemptsSinceLastFull += 1;
    }
    if (mode === 'full') {
      this.countersValue.fullDecodeAttempts += 1;
      this.attemptsSinceLastFull = 0;
    }

    if (!decoded) {
      this.countersValue.noQrFound += 1;
      this.countersValue.currentNoQrStreak += 1;
      this.countersValue.longestNoQrStreak = Math.max(this.countersValue.longestNoQrStreak, this.countersValue.currentNoQrStreak);
      if (mode === 'roi') {
        this.consecutiveRoiMisses += 1;
      }
      return {
        decodeResult: null,
        mode,
        inputWidth,
        inputHeight,
        trackingHint: {
          mode,
          geometry: null,
          sourceRegion,
          inputWidth,
          inputHeight,
          frameWidth,
          frameHeight
        }
      };
    }

    this.countersValue.qrDetected += 1;
    this.countersValue.currentNoQrStreak = 0;

    return {
      decodeResult: decoded,
      mode,
      inputWidth,
      inputHeight,
      trackingHint: {
        mode,
        geometry: decoded.geometry,
        sourceRegion,
        inputWidth,
        inputHeight,
        frameWidth,
        frameHeight
      }
    };
  }

  public noteSuccessfulProtocolDecode(hint: DecodeTrackingHint, acceptance: ProtocolAcceptance, nowMs: number): void {
    if (!hint.geometry) return;
    if (!acceptance.lockConfirmed) return;
    if (acceptance.activeTransferId && acceptance.activeTransferId !== acceptance.frameTransferId) return;

    this.lastSuccessAtMs = nowMs;
    this.consecutiveRoiMisses = 0;
    if (hint.mode === 'roi') this.countersValue.roiDecodeSuccesses += 1;
    if (hint.mode === 'full') this.countersValue.fullDecodeSuccesses += 1;
    this.roiBox = this.expandToPaddedRoi(
      hint.geometry,
      hint.sourceRegion,
      hint.inputWidth,
      hint.inputHeight,
      hint.frameWidth,
      hint.frameHeight
    );
  }

  private clearRoi(): void {
    if (this.roiBox) {
      this.countersValue.roiResets += 1;
    }
    this.roiBox = null;
    this.consecutiveRoiMisses = 0;
  }

  private expandToPaddedRoi(
    geometry: DecodeGeometry,
    region: RoiBox,
    decodedWidth: number,
    decodedHeight: number,
    frameWidth: number,
    frameHeight: number
  ): RoiBox {
    const mapped = geometry.corners.map((point) => ({
      x: region.x + (point.x / decodedWidth) * region.width,
      y: region.y + (point.y / decodedHeight) * region.height
    }));
    const minX = Math.min(...mapped.map((point) => point.x));
    const maxX = Math.max(...mapped.map((point) => point.x));
    const minY = Math.min(...mapped.map((point) => point.y));
    const maxY = Math.max(...mapped.map((point) => point.y));
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const padX = width * this.config.roiPaddingRatio;
    const padY = height * this.config.roiPaddingRatio;
    return this.clampBox(
      {
        x: minX - padX,
        y: minY - padY,
        width: width + (2 * padX),
        height: height + (2 * padY)
      },
      frameWidth,
      frameHeight
    );
  }

  private clampBox(box: RoiBox, maxWidth: number, maxHeight: number): RoiBox {
    const x = Math.max(0, Math.min(maxWidth - 1, Math.floor(box.x)));
    const y = Math.max(0, Math.min(maxHeight - 1, Math.floor(box.y)));
    const width = Math.max(1, Math.min(maxWidth - x, Math.ceil(box.width)));
    const height = Math.max(1, Math.min(maxHeight - y, Math.ceil(box.height)));
    return { x, y, width, height };
  }
}

export function polygonArea(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const next = points[(i + 1) % points.length];
    sum += points[i].x * next.y;
    sum -= next.x * points[i].y;
  }
  return Math.abs(sum / 2);
}
