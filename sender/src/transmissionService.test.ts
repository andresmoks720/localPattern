import { describe, expect, it, vi } from 'vitest';
import { FRAME_TYPE_DATA, FRAME_TYPE_END, FRAME_TYPE_HEADER } from '@qr-data-bridge/protocol';
import { SENDER_STAGE_TRANSITIONS, SenderTransmissionService } from './transmissionService';
import type { SenderStreamFrame } from './senderCore';

function frame(frameType: number, packetIndex = 0): SenderStreamFrame {
  if (frameType === FRAME_TYPE_DATA) return { frameType, packetIndex };
  return { frameType };
}

function makeDeps(frames: SenderStreamFrame[]) {
  return {
    getTotalFrames: () => frames.length,
    getFrameAt: (index: number) => frames[index] ?? null
  };
}

describe('SenderTransmissionService', () => {
  it('stops with restart-required error when hidden during transmission', async () => {
    vi.useFakeTimers();
    const rendered: number[] = [];
    const stages: string[] = [];
    const frames = [frame(FRAME_TYPE_HEADER), frame(FRAME_TYPE_DATA), frame(FRAME_TYPE_END)];

    const service = new SenderTransmissionService({
      ...makeDeps(frames),
      getFrameDisplayDurationMs: () => 10,
      renderFrame: async (idx) => { rendered.push(idx); },
      requestWakeLock: async () => undefined,
      releaseWakeLock: () => undefined,
      onEvent: (event) => {
        if (event.type === 'stageChanged') stages.push(event.payload.stage);
      }
    });

    service.loadTransfer();
    service.start();

    await vi.advanceTimersByTimeAsync(3000);

    expect(rendered).toEqual([0]);
    service.interruptForHiddenPage();
    expect(service.getStage()).toBe('ERROR');
    expect(stages).toContain('ERROR');
    vi.useRealTimers();
  });

  it('reset clears active state and frame diagnostics', async () => {
    vi.useFakeTimers();
    const frames = [frame(FRAME_TYPE_HEADER), frame(FRAME_TYPE_DATA), frame(FRAME_TYPE_END)];
    const service = new SenderTransmissionService({
      ...makeDeps(frames),
      getFrameDisplayDurationMs: () => 10,
      renderFrame: async () => undefined,
      requestWakeLock: async () => undefined,
      releaseWakeLock: () => undefined
    });

    service.loadTransfer();
    service.start();
    vi.advanceTimersByTime(4000);
    await vi.runAllTimersAsync();

    expect(service.getDiagnostics().framesRendered).toBeGreaterThan(0);
    service.reset();
    expect(service.getStage()).toBe('NO_FILE');
    expect(service.getDiagnostics().framesRendered).toBe(0);
    vi.useRealTimers();
  });

  it('uses fake timers to validate HEADER/DATA/END hold semantics', async () => {
    vi.useFakeTimers();
    const renderCalls: number[] = [];
    const frames = [frame(FRAME_TYPE_HEADER), frame(FRAME_TYPE_DATA), frame(FRAME_TYPE_END)];

    const service = new SenderTransmissionService({
      ...makeDeps(frames),
      getFrameDisplayDurationMs: (f) => {
        if (f.frameType === FRAME_TYPE_HEADER) return 2000;
        if (f.frameType === FRAME_TYPE_END) return 3000;
        return 2000;
      },
      renderFrame: async (index) => { renderCalls.push(index); },
      requestWakeLock: async () => undefined,
      releaseWakeLock: () => undefined
    });

    service.loadTransfer();
    service.start();

    await vi.advanceTimersByTimeAsync(3000);
    expect(renderCalls).toEqual([0]);

    await vi.advanceTimersByTimeAsync(1999);
    expect(renderCalls).toEqual([0]);

    await vi.advanceTimersByTimeAsync(1);
    expect(renderCalls).toEqual([0, 1]);

    await vi.advanceTimersByTimeAsync(2000);
    expect(renderCalls).toEqual([0, 1, 2]);

    vi.useRealTimers();
  });

  it('exposes explicit transition map and rejects forbidden transitions', () => {
    const frames: SenderStreamFrame[] = [];
    const service = new SenderTransmissionService({
      ...makeDeps(frames),
      getFrameDisplayDurationMs: () => 10,
      renderFrame: async () => undefined,
      requestWakeLock: async () => undefined,
      releaseWakeLock: () => undefined
    });

    expect(service.getTransitionMap()).toEqual(SENDER_STAGE_TRANSITIONS);

    // start in NO_FILE with no transfer loaded -> start is a no-op, stays valid
    service.start();
    expect(service.getStage()).toBe('NO_FILE');

    expect(() => (service as unknown as { transition: (stage: string) => void }).transition('TRANSMITTING')).toThrow('Invalid sender transition: NO_FILE -> TRANSMITTING');

    frames.push(frame(FRAME_TYPE_HEADER));
    service.loadTransfer();
    expect(service.getStage()).toBe('READY');
    service.reset();
    expect(service.getStage()).toBe('NO_FILE');
  });
});
