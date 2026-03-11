import { describe, expect, it } from 'vitest';
import { FRAME_TYPE_DATA, FRAME_TYPE_HEADER, PROTOCOL_ERROR_CODES, ProtocolError, assembleFrame, chunkFile, parseFrame, type TransferDataFrame, type TransferHeaderFrame } from './index';
import { RECEIVER_ERROR_CODES, RECEIVER_TIMEOUTS, ReceiverMachine } from './receiverMachine';

describe('receiver machine', () => {
  it('locks to first transferId and ignores other transfer data', () => {
    const machine = new ReceiverMachine();
    machine.startScanning();

    const transferA = chunkFile(new Uint8Array([1, 2, 3]), { fileName: 'a.bin', maxPayloadSize: 2, includeEndFrame: true });
    const transferB = chunkFile(new Uint8Array([9, 9]), { fileName: 'b.bin', maxPayloadSize: 2, includeEndFrame: true });

    machine.applyFrame(transferA.header, 1);
    machine.applyFrame(transferB.header, 2);
    machine.applyFrame(transferB.dataFrames[0], 3);

    const snapshot = machine.applyFrame(transferA.dataFrames[0], 4);
    expect(snapshot.transferId).toBeDefined();
    expect(snapshot.receivedCount).toBe(1);
    expect(snapshot.fileName).toBe('a.bin');
  });

  it('ignores DATA before HEADER and keeps scanning state', () => {
    const machine = new ReceiverMachine();
    machine.startScanning();

    const transfer = chunkFile(new Uint8Array([1, 2, 3]), { fileName: 'x.bin', maxPayloadSize: 2, includeEndFrame: true });
    const snapshot = machine.applyFrame(transfer.dataFrames[0], 1);

    expect(snapshot.state).toBe('SCANNING');
    expect(snapshot.receivedCount).toBe(0);
  });



  it('does not count duplicate DATA twice', () => {
    const machine = new ReceiverMachine();
    const transfer = chunkFile(new Uint8Array([1, 2, 3]), { fileName: 'dup.bin', maxPayloadSize: 2, includeEndFrame: true });
    machine.startScanning();
    machine.applyFrame(transfer.header, 1);
    machine.applyFrame(transfer.dataFrames[0], 2);
    const snapshot = machine.applyFrame(transfer.dataFrames[0], 3);

    expect(snapshot.receivedCount).toBe(1);
  });

  it('completes with full packet set and matching crc', () => {
    const machine = new ReceiverMachine();
    const transfer = chunkFile(new Uint8Array([1, 2, 3, 4]), { fileName: 'ok.bin', maxPayloadSize: 2, includeEndFrame: true });
    machine.startScanning();
    machine.applyFrame(transfer.header, 1);
    machine.applyFrame(transfer.dataFrames[0], 2);
    const snapshot = machine.applyFrame(transfer.dataFrames[1], 3);

    expect(snapshot.state).toBe('SUCCESS');
    expect(snapshot.fileBytes).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('ignores END from wrong transferId', () => {
    const machine = new ReceiverMachine();
    const transferA = chunkFile(new Uint8Array([1, 2, 3, 4]), { fileName: 'a.bin', maxPayloadSize: 2, includeEndFrame: true });
    const transferB = chunkFile(new Uint8Array([9]), { fileName: 'b.bin', maxPayloadSize: 1, includeEndFrame: true });
    machine.startScanning();
    machine.applyFrame(transferA.header, 1);
    machine.applyFrame(transferA.dataFrames[0], 2);
    const snapshot = machine.applyFrame(transferB.endFrame!, 3);

    expect(snapshot.state).toBe('RECEIVING');
    expect(snapshot.endSeenAt).toBeNull();
  });


  it('handles zero timestamps for timeout bookkeeping', () => {
    const machine = new ReceiverMachine();
    const transfer = chunkFile(new Uint8Array([1, 2, 3]), { fileName: 'zero-time.bin', maxPayloadSize: 2, includeEndFrame: true });
    machine.startScanning();
    machine.applyFrame(transfer.header, 0);

    const snapshot = machine.tick(RECEIVER_TIMEOUTS.NO_UNIQUE_PROGRESS_TIMEOUT_MS + 1);
    expect(snapshot.state).toBe('ERROR');
    expect(snapshot.error?.code).toBe(RECEIVER_ERROR_CODES.NO_PROGRESS_TIMEOUT);
  });

  it('times out after HEADER if no unique packet progress occurs', () => {
    const machine = new ReceiverMachine();
    const transfer = chunkFile(new Uint8Array([1, 2, 3]), { fileName: 'idle-after-header.bin', maxPayloadSize: 2, includeEndFrame: true });
    machine.startScanning();
    machine.applyFrame(transfer.header, 100);

    const snapshot = machine.tick(100 + RECEIVER_TIMEOUTS.NO_UNIQUE_PROGRESS_TIMEOUT_MS + 1);
    expect(snapshot.state).toBe('ERROR');
    expect(snapshot.error?.code).toBe(RECEIVER_ERROR_CODES.NO_PROGRESS_TIMEOUT);
  });

  it('times out on no unique progress', () => {
    const machine = new ReceiverMachine();
    const transfer = chunkFile(new Uint8Array([1, 2, 3]), { fileName: 'x.bin', maxPayloadSize: 2, includeEndFrame: true });
    machine.startScanning();
    machine.applyFrame(transfer.header, 100);
    machine.applyFrame(transfer.dataFrames[0], 110);

    const snapshot = machine.tick(110 + RECEIVER_TIMEOUTS.NO_UNIQUE_PROGRESS_TIMEOUT_MS + 1);
    expect(snapshot.state).toBe('ERROR');
    expect(snapshot.error?.code).toBe(RECEIVER_ERROR_CODES.NO_PROGRESS_TIMEOUT);
  });


  it('handles zero timestamp END grace timeout', () => {
    const machine = new ReceiverMachine();
    const transfer = chunkFile(new Uint8Array([1, 2, 3, 4]), { fileName: 'zero-end.bin', maxPayloadSize: 2, includeEndFrame: true });
    machine.startScanning();
    machine.applyFrame(transfer.header, 0);
    machine.applyFrame(transfer.endFrame!, 0);

    const snapshot = machine.tick(RECEIVER_TIMEOUTS.END_GRACE_MS + 1);
    expect(snapshot.state).toBe('ERROR');
    expect(snapshot.error?.code).toBe(RECEIVER_ERROR_CODES.END_INCOMPLETE);
  });

  it('fails when END arrives and transfer remains incomplete past grace window', () => {
    const machine = new ReceiverMachine();
    const transfer = chunkFile(new Uint8Array([1, 2, 3, 4]), { fileName: 'x.bin', maxPayloadSize: 2, includeEndFrame: true });
    machine.startScanning();
    machine.applyFrame(transfer.header, 100);
    machine.applyFrame(transfer.dataFrames[0], 150);
    machine.applyFrame(transfer.endFrame!, 200);

    const snapshot = machine.tick(200 + RECEIVER_TIMEOUTS.END_GRACE_MS + 1);
    expect(snapshot.state).toBe('ERROR');
    expect(snapshot.error?.code).toBe(RECEIVER_ERROR_CODES.END_INCOMPLETE);
  });

  it('supports zero-byte files deterministically', () => {
    const machine = new ReceiverMachine();
    const transfer = chunkFile(new Uint8Array(), { fileName: 'empty.bin', maxPayloadSize: 4, includeEndFrame: true });
    machine.startScanning();
    machine.applyFrame(transfer.header, 1);
    const snapshot = machine.applyFrame(transfer.dataFrames[0], 2);

    expect(snapshot.state).toBe('SUCCESS');
    expect(snapshot.fileBytes?.length).toBe(0);
  });

  it('requires transferId in data frames', () => {
    const transferId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const transfer = chunkFile(new Uint8Array([7]), { fileName: 'req.bin', transferId, includeEndFrame: true });
    const validData = assembleFrame(transfer.dataFrames[0]);
    const missingTransferId = new Uint8Array(validData.length - 8);
    missingTransferId.set(validData.slice(0, 6), 0);
    missingTransferId.set(validData.slice(14), 6);

    expect(() => parseFrame(missingTransferId)).toThrowError(ProtocolError);
    try {
      parseFrame(missingTransferId);
    } catch (error) {
      expect((error as ProtocolError).code).toBe(PROTOCOL_ERROR_CODES.MALFORMED_DATA);
    }
  });

  it('rejects full-file crc mismatch in receiver flow', () => {
    const machine = new ReceiverMachine();
    const transfer = chunkFile(new Uint8Array([1, 2, 3]), { fileName: 'bad.bin', maxPayloadSize: 3, includeEndFrame: true });
    const badHeader: TransferHeaderFrame = {
      ...transfer.header,
      fileCrc32: transfer.header.fileCrc32 + 1,
      frameType: FRAME_TYPE_HEADER
    };

    machine.startScanning();
    machine.applyFrame(badHeader, 1);
    const snapshot = machine.applyFrame(transfer.dataFrames[0], 2);

    expect(snapshot.state).toBe('ERROR');
    expect(snapshot.error?.code).toBe(RECEIVER_ERROR_CODES.FILE_CRC_MISMATCH);
  });

  it('ignores out-of-range packet indexes', () => {
    const machine = new ReceiverMachine();
    const transfer = chunkFile(new Uint8Array([1, 2, 3]), { fileName: 'bounds.bin', maxPayloadSize: 3, includeEndFrame: true });
    machine.startScanning();
    machine.applyFrame(transfer.header, 1);

    const outOfRange: TransferDataFrame = {
      ...transfer.dataFrames[0],
      frameType: FRAME_TYPE_DATA,
      packetIndex: 10
    };

    const snapshot = machine.applyFrame(outOfRange, 2);
    expect(snapshot.receivedCount).toBe(0);
    expect(snapshot.state).toBe('RECEIVING');
  });
});
