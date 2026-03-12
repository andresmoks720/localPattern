import { describe, expect, it, vi } from 'vitest';
import { FRAME_TYPE_DATA, FRAME_TYPE_END, FRAME_TYPE_HEADER, type TransferFrame } from '@qr-data-bridge/protocol';
import { SENDER_STAGE_TRANSITIONS, SenderTransmissionService } from './transmissionService';

function frame(frameType: number, packetIndex = 0): TransferFrame {
  const transferId = new Uint8Array(8);
  if (frameType === FRAME_TYPE_HEADER) {
    return { frameType, transferId, fileName: 'f.bin', fileSize: 3, totalPackets: 1, fileCrc32: 0, headerCrc32: 0 };
  }
  if (frameType === FRAME_TYPE_END) {
    return { frameType, transferId };
  }
  return { frameType: FRAME_TYPE_DATA, transferId, packetIndex, payloadLen: 1, payload: new Uint8Array([1]), packetCrc32: 0 };
}

describe('SenderTransmissionService', () => {
  it('stops with restart-required error when hidden during transmission', async () => {
    vi.useFakeTimers();
    const rendered: number[] = [];
    const stages: string[] = [];

    const service = new SenderTransmissionService({
      getFrameDisplayDurationMs: () => 10,
      renderFrame: async (idx) => { rendered.push(idx); },
      requestWakeLock: async () => undefined,
      releaseWakeLock: () => undefined,
      onEvent: (event) => {
        if (event.type === 'stageChanged') stages.push(event.payload.stage);
      }
    });

    service.loadFrames([frame(FRAME_TYPE_HEADER), frame(FRAME_TYPE_DATA), frame(FRAME_TYPE_END)]);
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
    const service = new SenderTransmissionService({
      getFrameDisplayDurationMs: () => 10,
      renderFrame: async () => undefined,
      requestWakeLock: async () => undefined,
      releaseWakeLock: () => undefined
    });

    service.loadFrames([frame(FRAME_TYPE_HEADER), frame(FRAME_TYPE_DATA), frame(FRAME_TYPE_END)]);
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

    const service = new SenderTransmissionService({
      getFrameDisplayDurationMs: (f) => {
        if (f.frameType === FRAME_TYPE_HEADER) return 2000;
        if (f.frameType === FRAME_TYPE_END) return 3000;
        return 2000;
      },
      renderFrame: async (index) => { renderCalls.push(index); },
      requestWakeLock: async () => undefined,
      releaseWakeLock: () => undefined
    });

    service.loadFrames([frame(FRAME_TYPE_HEADER), frame(FRAME_TYPE_DATA), frame(FRAME_TYPE_END)]);
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
    const service = new SenderTransmissionService({
      getFrameDisplayDurationMs: () => 10,
      renderFrame: async () => undefined,
      requestWakeLock: async () => undefined,
      releaseWakeLock: () => undefined
    });

    expect(service.getTransitionMap()).toEqual(SENDER_STAGE_TRANSITIONS);

    // start in NO_FILE with no frames loaded -> start is a no-op, stays valid
    service.start();
    expect(service.getStage()).toBe('NO_FILE');

    expect(() => (service as unknown as { transition: (stage: string) => void }).transition('TRANSMITTING')).toThrow('Invalid sender transition: NO_FILE -> TRANSMITTING');

    // load frames transitions into READY; then reset returns to NO_FILE
    service.loadFrames([frame(FRAME_TYPE_HEADER)]);
    expect(service.getStage()).toBe('READY');
    service.reset();
    expect(service.getStage()).toBe('NO_FILE');
  });
});
