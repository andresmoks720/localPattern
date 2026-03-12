import { FRAME_TYPE_DATA, type TransferFrame } from '@qr-data-bridge/protocol';
import type { SenderStreamFrame } from './senderCore';

export type SenderStage = 'NO_FILE' | 'READY' | 'COUNTDOWN' | 'TRANSMITTING' | 'COMPLETE' | 'ERROR';

export const SENDER_STAGE_TRANSITIONS: Record<SenderStage, SenderStage[]> = {
  NO_FILE: ['NO_FILE', 'READY', 'ERROR'],
  READY: ['READY', 'COUNTDOWN', 'ERROR', 'NO_FILE'],
  COUNTDOWN: ['COUNTDOWN', 'TRANSMITTING', 'READY', 'ERROR', 'NO_FILE'],
  TRANSMITTING: ['TRANSMITTING', 'COMPLETE', 'ERROR', 'READY', 'NO_FILE'],
  COMPLETE: ['COMPLETE', 'READY', 'NO_FILE'],
  ERROR: ['ERROR', 'READY', 'NO_FILE']
};

export interface SenderTransmissionEventMap {
  stageChanged: { stage: SenderStage; message?: string };
  frameRendered: { index: number; frame: SenderStreamFrame };
  complete: { totalFrames: number };
  failed: { message: string };
}

export type SenderTransmissionEvent = {
  [K in keyof SenderTransmissionEventMap]: { type: K; payload: SenderTransmissionEventMap[K] }
}[keyof SenderTransmissionEventMap];

export interface SenderTransmissionDiagnostics {
  framesRendered: number;
  dataFramesRendered: number;
  startedAt: number | null;
  completedAt: number | null;
}

interface SenderTransmissionDeps {
  getTotalFrames(): number;
  getFrameAt(index: number): SenderStreamFrame | null;
  getFrameDisplayDurationMs(frame: SenderStreamFrame): number;
  renderFrame(index: number, frame: SenderStreamFrame): Promise<void>;
  requestWakeLock(): Promise<void>;
  releaseWakeLock(): void;
  onEvent?: (event: SenderTransmissionEvent) => void;
  setTimeoutFn?: typeof window.setTimeout;
  clearTimeoutFn?: typeof window.clearTimeout;
  now?: () => number;
}

export class SenderTransmissionService {
  private readonly deps: Required<Omit<SenderTransmissionDeps, 'onEvent'>> & Pick<SenderTransmissionDeps, 'onEvent'>;
  private currentIndex = 0;
  private stage: SenderStage = 'NO_FILE';
  private transmissionTimer: number | null = null;
  private countdownTimer: number | null = null;
  private isTransmitting = false;
  private diagnosticsValue: SenderTransmissionDiagnostics = {
    framesRendered: 0,
    dataFramesRendered: 0,
    startedAt: null,
    completedAt: null
  };

  constructor(deps: SenderTransmissionDeps) {
    const fallbackSetTimeout = ((handler: TimerHandler, timeout?: number) => setTimeout(handler, timeout)) as typeof window.setTimeout;
    const fallbackClearTimeout = ((id: number) => clearTimeout(id)) as typeof window.clearTimeout;
    this.deps = {
      setTimeoutFn: fallbackSetTimeout,
      clearTimeoutFn: fallbackClearTimeout,
      now: () => Date.now(),
      ...deps
    };
  }

  public loadTransfer(): void {
    this.stop('Transmission stopped.', 'READY');
    this.currentIndex = 0;
    this.diagnosticsValue = { framesRendered: 0, dataFramesRendered: 0, startedAt: null, completedAt: null };
    this.transition(this.deps.getTotalFrames() ? 'READY' : 'NO_FILE', this.deps.getTotalFrames() ? 'Ready to transmit' : 'No file selected');
  }

  public getStage(): SenderStage {
    return this.stage;
  }

  public getTransitionMap(): Record<SenderStage, SenderStage[]> {
    return SENDER_STAGE_TRANSITIONS;
  }

  public getDiagnostics(): SenderTransmissionDiagnostics {
    return { ...this.diagnosticsValue };
  }

  public start(): void {
    if (!this.deps.getTotalFrames()) return;
    this.stop('Transmission stopped.', 'READY');
    this.isTransmitting = true;
    this.currentIndex = 0;
    this.diagnosticsValue.startedAt = this.deps.now();
    this.transition('COUNTDOWN', 'Starting in…');
    this.runCountdown(3);
  }

  public stop(message = 'Transmission stopped.', stage: SenderStage = 'READY'): void {
    if (this.transmissionTimer !== null) this.deps.clearTimeoutFn(this.transmissionTimer);
    if (this.countdownTimer !== null) this.deps.clearTimeoutFn(this.countdownTimer);
    this.transmissionTimer = null;
    this.countdownTimer = null;
    this.isTransmitting = false;
    this.deps.releaseWakeLock();
    if (this.deps.getTotalFrames() > 0) {
      this.transition(stage, message);
    }
  }

  public reset(): void {
    this.stop('No file selected', 'NO_FILE');
    this.currentIndex = 0;
    this.diagnosticsValue = { framesRendered: 0, dataFramesRendered: 0, startedAt: null, completedAt: null };
    this.transition('NO_FILE', 'No file selected');
  }

  public interruptForHiddenPage(): void {
    if (this.isTransmitting) {
      this.stop('Transmission interrupted. Restart required.', 'ERROR');
    }
  }

  private runCountdown(tick: number): void {
    if (!this.isTransmitting) return;
    this.emit({ type: 'stageChanged', payload: { stage: 'COUNTDOWN', message: `Starting in ${tick}...` } });
    if (tick === 0) {
      void this.beginTransmission();
      return;
    }

    this.countdownTimer = this.deps.setTimeoutFn(() => this.runCountdown(tick - 1), 1000);
  }

  private async beginTransmission(): Promise<void> {
    if (!this.isTransmitting) return;
    this.transition('TRANSMITTING');
    await this.deps.requestWakeLock();

    try {
      await this.renderCurrentFrame();
      this.scheduleNextFrame();
    } catch (error) {
      this.fail(`Error: QR encode failed: ${error instanceof Error ? error.message : 'Unknown QR encoding error.'}`);
    }
  }

  private scheduleNextFrame(): void {
    const totalFrames = this.deps.getTotalFrames();
    if (!this.isTransmitting || totalFrames === 0) return;
    const currentFrame = this.deps.getFrameAt(this.currentIndex);
    if (!currentFrame) {
      this.fail('Error: QR encode failed: stream frame unavailable.');
      return;
    }

    this.transmissionTimer = this.deps.setTimeoutFn(async () => {
      if (!this.isTransmitting) return;
      const nextIndex = this.currentIndex + 1;
      if (nextIndex >= totalFrames) {
        this.diagnosticsValue.completedAt = this.deps.now();
        this.stop('Transmission finished. If receiver did not complete, restart sender.', 'COMPLETE');
        this.emit({ type: 'complete', payload: { totalFrames } });
        return;
      }

      this.currentIndex = nextIndex;
      try {
        await this.renderCurrentFrame();
        this.scheduleNextFrame();
      } catch (error) {
        this.fail(`Error: QR encode failed: ${error instanceof Error ? error.message : 'Unknown QR encoding error.'}`);
      }
    }, this.deps.getFrameDisplayDurationMs(currentFrame));
  }

  private async renderCurrentFrame(): Promise<void> {
    const frame = this.deps.getFrameAt(this.currentIndex);
    if (!frame) {
      throw new Error('stream frame unavailable.');
    }
    await this.deps.renderFrame(this.currentIndex, frame);
    this.diagnosticsValue.framesRendered += 1;
    if (frame.frameType === FRAME_TYPE_DATA) this.diagnosticsValue.dataFramesRendered += 1;
    this.emit({ type: 'frameRendered', payload: { index: this.currentIndex, frame } });
  }

  private fail(message: string): void {
    this.stop(message, 'ERROR');
    this.emit({ type: 'failed', payload: { message } });
  }

  private transition(stage: SenderStage, message?: string): void {
    const allowed = SENDER_STAGE_TRANSITIONS[this.stage];
    if (!allowed.includes(stage)) {
      throw new Error(`Invalid sender transition: ${this.stage} -> ${stage}`);
    }
    this.stage = stage;
    this.emit({ type: 'stageChanged', payload: { stage, message } });
  }

  private emit(event: SenderTransmissionEvent): void {
    this.deps.onEvent?.(event);
  }
}
