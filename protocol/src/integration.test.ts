import { describe, expect, it } from 'vitest';
import { RECEIVER_ERROR_CODES, ReceiverMachine, assembleFrame, chunkFile, parseFrame, type ReceiverSnapshot, type TransferFrame } from './index';

function runFrames(machine: ReceiverMachine, frames: Uint8Array[], startNow = 1_000): ReceiverSnapshot {
  let now = startNow;
  machine.startScanning();
  let snapshot = machine.snapshot;

  for (const frameBytes of frames) {
    const parsedFrame = parseFrame(frameBytes);
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
    let snapshot = machine.applyFrame(header, 1_000);
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
    let snapshot = machine.applyFrame(header, 2_000);
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
    machine.applyFrame(parseFrame(assembleFrame(nonEmptyTransfer.header)), 10_000);
    machine.applyFrame(parseFrame(assembleFrame(nonEmptyTransfer.dataFrames[0])), 10_050);
    machine.applyFrame(parseFrame(assembleFrame(nonEmptyTransfer.endFrame!)), 10_100);

    snapshot = machine.tick(12_200);
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

    machine.applyFrame(parseFrame(assembleFrame(transferA.header)), 5_000);
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

    machine.applyFrame(parseFrame(assembleFrame(firstTransfer.header)), 7_000);
    const snapshot = machine.applyFrame(parseFrame(assembleFrame(conflictingTransfer.header)), 7_050);

    expect(snapshot.state).toBe('ERROR');
    expect(snapshot.error?.code).toBe(RECEIVER_ERROR_CODES.HEADER_CONFLICT);
  });

  it('times out on no unique progress when only duplicates are received', () => {
    const transfer = chunkFile(new Uint8Array([10, 20, 30, 40]), {
      fileName: 'duplicates.bin',
      maxPayloadSize: 2,
      includeEndFrame: true
    });

    const machine = new ReceiverMachine();
    machine.startScanning();

    machine.applyFrame(parseFrame(assembleFrame(transfer.header)), 20_000);
    machine.applyFrame(parseFrame(assembleFrame(transfer.dataFrames[0])), 20_100);

    let snapshot = machine.applyFrame(parseFrame(assembleFrame(transfer.dataFrames[0])), 20_200);
    expect(snapshot.receivedCount).toBe(1);

    snapshot = machine.tick(35_200);
    expect(snapshot.state).toBe('ERROR');
    expect(snapshot.error?.code).toBe(RECEIVER_ERROR_CODES.NO_PROGRESS_TIMEOUT);
  });
});
