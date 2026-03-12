import { describe, expect, it } from 'vitest';
import { FRAME_TYPE_HEADER, RECEIVER_ERROR_CODES, RECEIVER_LOCK_CONFIRMATION, RECEIVER_TIMEOUTS, ReceiverMachine, assembleFrame, chunkFile, parseFrame, type ReceiverSnapshot, type TransferFrame } from './index';


function confirmHeaderLock(machine: ReceiverMachine, frame: TransferFrame, startNow: number): void {
  if (frame.frameType !== FRAME_TYPE_HEADER) throw new Error('Expected HEADER frame');
  for (let i = 0; i < RECEIVER_LOCK_CONFIRMATION.REQUIRED_HEADERS; i += 1) {
    machine.applyFrame(frame, startNow + i);
  }
}

function runFrames(machine: ReceiverMachine, frames: Uint8Array[], startNow = 1_000): ReceiverSnapshot {
  let now = startNow;
  machine.startScanning();
  let snapshot = machine.snapshot;

  for (let index = 0; index < frames.length; index += 1) {
    const parsedFrame = parseFrame(frames[index]);
    if (index === 0 && parsedFrame.frameType === FRAME_TYPE_HEADER) {
      confirmHeaderLock(machine, parsedFrame, now);
      now += 50 * RECEIVER_LOCK_CONFIRMATION.REQUIRED_HEADERS;
      snapshot = machine.snapshot;
      continue;
    }
    snapshot = machine.applyFrame(parsedFrame, now);
    now += 50;
  }

  return snapshot;
}

function toWireFrames(frames: TransferFrame[]): Uint8Array[] {
  return frames.map((frame) => assembleFrame(frame));
}

describe('protocol integration', () => {
  it('completes an end-to-end non-empty transfer from chunking to receiver verification', () => {
    const file = new TextEncoder().encode('integration transfer payload: hello qr bridge');
    const transfer = chunkFile(file, {
      fileName: 'integration.txt',
      maxPayloadSize: 8,
      includeEndFrame: true
    });

    const machine = new ReceiverMachine();
    const frames = [transfer.header, ...transfer.dataFrames, transfer.endFrame].filter((frame): frame is TransferFrame => Boolean(frame));
    const finalSnapshot = runFrames(machine, toWireFrames(frames));

    expect(finalSnapshot.state).toBe('SUCCESS');
    expect(finalSnapshot.error).toBeUndefined();
    expect(finalSnapshot.fileBytes).toEqual(file);
    expect(finalSnapshot.receivedCount).toBe(transfer.dataFrames.length);
  });

  it('drops corrupted data frames but still succeeds when a valid duplicate arrives later', () => {
    const file = new Uint8Array([11, 22, 33, 44, 55, 66]);
    const transfer = chunkFile(file, {
      fileName: 'retry.bin',
      maxPayloadSize: 3,
      includeEndFrame: true
    });

    const machine = new ReceiverMachine();
    machine.startScanning();

    const header = parseFrame(assembleFrame(transfer.header));
    confirmHeaderLock(machine, header, 1_000);
    let snapshot = machine.snapshot;
    expect(snapshot.state).toBe('RECEIVING');

    const firstDataWire = assembleFrame(transfer.dataFrames[0]);
    const corruptedFirstData = firstDataWire.slice();
    corruptedFirstData[17] ^= 0xff;

    expect(() => parseFrame(corruptedFirstData)).toThrow();

    const secondData = parseFrame(assembleFrame(transfer.dataFrames[1]));
    snapshot = machine.applyFrame(secondData, 1_050);
    expect(snapshot.receivedCount).toBe(1);

    const validFirstData = parseFrame(firstDataWire);
    snapshot = machine.applyFrame(validFirstData, 1_100);
    expect(snapshot.receivedCount).toBe(2);
    expect(snapshot.state).toBe('SUCCESS');
    expect(snapshot.fileBytes).toEqual(file);
  });

  it('enforces zero-byte completion only after END and fails on incomplete END timeout', () => {
    const emptyTransfer = chunkFile(new Uint8Array(), {
      fileName: 'empty.bin',
      includeEndFrame: true
    });

    const machine = new ReceiverMachine();
    machine.startScanning();

    const header = parseFrame(assembleFrame(emptyTransfer.header));
    confirmHeaderLock(machine, header, 2_000);
    let snapshot = machine.snapshot;
    expect(snapshot.state).toBe('RECEIVING');

    snapshot = machine.tick(4_500);
    expect(snapshot.state).toBe('RECEIVING');

    const end = parseFrame(assembleFrame(emptyTransfer.endFrame!));
    snapshot = machine.applyFrame(end, 4_550);
    expect(snapshot.state).toBe('SUCCESS');
    expect(snapshot.fileBytes).toEqual(new Uint8Array());

    const nonEmptyTransfer = chunkFile(new Uint8Array([1, 2, 3, 4]), {
      fileName: 'partial.bin',
      maxPayloadSize: 2,
      includeEndFrame: true
    });

    machine.startScanning();
    confirmHeaderLock(machine, parseFrame(assembleFrame(nonEmptyTransfer.header)), 10_000);
    machine.applyFrame(parseFrame(assembleFrame(nonEmptyTransfer.dataFrames[0])), 10_050);
    machine.applyFrame(parseFrame(assembleFrame(nonEmptyTransfer.endFrame!)), 10_100);

    snapshot = machine.tick(10_100 + RECEIVER_TIMEOUTS.END_GRACE_MS + 10);
    expect(snapshot.state).toBe('ERROR');
    expect(snapshot.error?.code).toBe(RECEIVER_ERROR_CODES.END_INCOMPLETE);
  });

  it('ignores wrong-transfer frames after lock and still completes locked transfer', () => {
    const transferA = chunkFile(new Uint8Array([1, 2, 3, 4]), {
      fileName: 'a.bin',
      maxPayloadSize: 2,
      includeEndFrame: true
    });
    const transferB = chunkFile(new Uint8Array([9, 9, 9, 9]), {
      fileName: 'b.bin',
      maxPayloadSize: 2,
      includeEndFrame: true
    });

    const machine = new ReceiverMachine();
    machine.startScanning();

    confirmHeaderLock(machine, parseFrame(assembleFrame(transferA.header)), 5_000);
    let snapshot = machine.applyFrame(parseFrame(assembleFrame(transferB.header)), 5_050);
    expect(snapshot.transferId).toBe(Array.from(transferA.header.transferId).map((value) => value.toString(16).padStart(2, '0')).join(''));

    snapshot = machine.applyFrame(parseFrame(assembleFrame(transferB.dataFrames[0])), 5_100);
    expect(snapshot.receivedCount).toBe(0);

    snapshot = machine.applyFrame(parseFrame(assembleFrame(transferA.dataFrames[0])), 5_150);
    expect(snapshot.receivedCount).toBe(1);

    snapshot = machine.applyFrame(parseFrame(assembleFrame(transferA.dataFrames[1])), 5_200);
    expect(snapshot.state).toBe('SUCCESS');
    expect(snapshot.fileBytes).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('fails with HEADER_CONFLICT when same transferId arrives with conflicting metadata', () => {
    const transferId = new Uint8Array([1, 1, 2, 3, 5, 8, 13, 21]);
    const firstTransfer = chunkFile(new Uint8Array([5, 6, 7, 8]), {
      transferId,
      fileName: 'conflict.bin',
      maxPayloadSize: 2,
      includeEndFrame: true
    });
    const conflictingTransfer = chunkFile(new Uint8Array([5, 6, 7, 8]), {
      transferId,
      fileName: 'conflict-renamed.bin',
      maxPayloadSize: 2,
      includeEndFrame: true
    });

    const machine = new ReceiverMachine();
    machine.startScanning();

    confirmHeaderLock(machine, parseFrame(assembleFrame(firstTransfer.header)), 7_000);
    const snapshot = machine.applyFrame(parseFrame(assembleFrame(conflictingTransfer.header)), 7_050);

    expect(snapshot.state).toBe('ERROR');
    expect(snapshot.error?.code).toBe(RECEIVER_ERROR_CODES.HEADER_CONFLICT);
  });

  it('does not time out while locked-transfer duplicates keep arriving within activity grace window', () => {
    const transfer = chunkFile(new Uint8Array([10, 20, 30, 40]), {
      fileName: 'duplicates.bin',
      maxPayloadSize: 2,
      includeEndFrame: true
    });

    const machine = new ReceiverMachine();
    machine.startScanning();

    confirmHeaderLock(machine, parseFrame(assembleFrame(transfer.header)), 20_000);
    machine.applyFrame(parseFrame(assembleFrame(transfer.dataFrames[0])), 20_100);

    let now = 20_200;
    let snapshot = machine.snapshot;
    while (now <= 35_500) {
      snapshot = machine.applyFrame(parseFrame(assembleFrame(transfer.dataFrames[0])), now);
      now += 1_000;
    }

    snapshot = machine.tick(35_600);
    expect(snapshot.state).toBe('RECEIVING');
    expect(snapshot.error).toBeUndefined();

    snapshot = machine.tick(37_700);
    expect(snapshot.state).toBe('ERROR');
    expect(snapshot.error?.code).toBe(RECEIVER_ERROR_CODES.NO_PROGRESS_TIMEOUT);
  });

  it('times out on no unique progress when there is no locked-transfer activity', () => {
    const transfer = chunkFile(new Uint8Array([10, 20, 30, 40]), {
      fileName: 'stall.bin',
      maxPayloadSize: 2,
      includeEndFrame: true
    });

    const machine = new ReceiverMachine();
    machine.startScanning();

    confirmHeaderLock(machine, parseFrame(assembleFrame(transfer.header)), 40_000);
    machine.applyFrame(parseFrame(assembleFrame(transfer.dataFrames[0])), 40_100);

    const snapshot = machine.tick(55_101);
    expect(snapshot.state).toBe('ERROR');
    expect(snapshot.error?.code).toBe(RECEIVER_ERROR_CODES.NO_PROGRESS_TIMEOUT);
  });
});
