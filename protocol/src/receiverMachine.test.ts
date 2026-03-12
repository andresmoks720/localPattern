import { describe, expect, it } from 'vitest';
import { FRAME_TYPE_DATA, FRAME_TYPE_HEADER, PROTOCOL_ERROR_CODES, ProtocolError, assembleFrame, chunkFile, parseFrame, type TransferDataFrame, type TransferHeaderFrame } from './index';
import { RECEIVER_ERROR_CODES, RECEIVER_LOCK_CONFIRMATION, RECEIVER_STATE_TRANSITIONS, RECEIVER_TIMEOUTS, ReceiverMachine } from './receiverMachine';


function confirmHeaderLock(machine: ReceiverMachine, header: TransferHeaderFrame, startNow = 1): void {
  for (let i = 0; i < RECEIVER_LOCK_CONFIRMATION.REQUIRED_HEADERS; i += 1) {
    machine.applyFrame(header, startNow + i);
  }
}

describe('receiver machine', () => {
  it('locks to first transferId and ignores other transfer data', () => {
    const machine = new ReceiverMachine();
    machine.startScanning();

    const transferA = chunkFile(new Uint8Array([1, 2, 3]), { fileName: 'a.bin', maxPayloadSize: 2, includeEndFrame: true });
    const transferB = chunkFile(new Uint8Array([9, 9]), { fileName: 'b.bin', maxPayloadSize: 2, includeEndFrame: true });

    confirmHeaderLock(machine, transferA.header, 1);
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

  it('does not lock on a single accidental HEADER', () => {
    const machine = new ReceiverMachine();
    machine.startScanning();
    const transfer = chunkFile(new Uint8Array([1, 2]), { fileName: 'single.bin', maxPayloadSize: 2, includeEndFrame: true });

    const snapshot = machine.applyFrame(transfer.header, 1);
    expect(snapshot.state).toBe('SCANNING');
    expect(snapshot.lockConfirmed).toBe(false);
    expect(snapshot.transferId).toBeNull();
  });

  it('errors on conflicting same-transfer HEADER metadata', () => {
    const machine = new ReceiverMachine();
    machine.startScanning();

    const transfer = chunkFile(new Uint8Array([1, 2, 3]), { fileName: 'a.bin', maxPayloadSize: 2, includeEndFrame: true });
    confirmHeaderLock(machine, transfer.header, 1);

    const conflictingHeader: TransferHeaderFrame = {
      ...transfer.header,
      fileName: 'renamed.bin'
    };

    const snapshot = machine.applyFrame(conflictingHeader, 2);
    expect(snapshot.state).toBe('ERROR');
    expect(snapshot.error?.code).toBe(RECEIVER_ERROR_CODES.HEADER_CONFLICT);
  });

  it('does not count duplicate DATA twice', () => {
    const machine = new ReceiverMachine();
    const transfer = chunkFile(new Uint8Array([1, 2, 3]), { fileName: 'dup.bin', maxPayloadSize: 2, includeEndFrame: true });
    machine.startScanning();
    confirmHeaderLock(machine, transfer.header, 1);
    machine.applyFrame(transfer.dataFrames[0], 2);
    const snapshot = machine.applyFrame(transfer.dataFrames[0], 3);

    expect(snapshot.receivedCount).toBe(1);
  });

  it('completes with full packet set and matching crc', () => {
    const machine = new ReceiverMachine();
    const transfer = chunkFile(new Uint8Array([1, 2, 3, 4]), { fileName: 'ok.bin', maxPayloadSize: 2, includeEndFrame: true });
    machine.startScanning();
    confirmHeaderLock(machine, transfer.header, 1);
    machine.applyFrame(transfer.dataFrames[0], 2);
    const snapshot = machine.applyFrame(transfer.dataFrames[1], 3);

    expect(snapshot.state).toBe('SUCCESS');
    expect(snapshot.fileBytes).toEqual(new Uint8Array([1, 2, 3, 4]));
  });



  it('tracks last contiguous packet and missing ranges while waiting for out-of-order packets', () => {
    const machine = new ReceiverMachine();
    const transfer = chunkFile(new Uint8Array([1, 2, 3, 4, 5, 6]), { fileName: 'gaps.bin', maxPayloadSize: 2, includeEndFrame: true });
    machine.startScanning();
    confirmHeaderLock(machine, transfer.header, 1);

    const afterPacket2 = machine.applyFrame(transfer.dataFrames[2], 10);
    expect(afterPacket2.lastContiguousPacketIndex).toBe(-1);
    expect(afterPacket2.missingRanges).toEqual([{ start: 0, end: 1 }]);

    const afterPacket0 = machine.applyFrame(transfer.dataFrames[0], 11);
    expect(afterPacket0.lastContiguousPacketIndex).toBe(0);
    expect(afterPacket0.missingRanges).toEqual([{ start: 1, end: 1 }]);

    const afterPacket1 = machine.applyFrame(transfer.dataFrames[1], 12);
    expect(afterPacket1.lastContiguousPacketIndex).toBe(2);
    expect(afterPacket1.missingRanges).toEqual([]);
    expect(afterPacket1.state).toBe('SUCCESS');
  });

  it('emits structured gap lifecycle events including permanently-lost timeout outcomes', () => {
    const gapEvents: Array<{
      type: string;
      expectedSeq: number;
      receivedSeq: number;
      gapSize: number;
      permanentlyLost: boolean;
      retransmitRequested: boolean;
      streamId: string;
    }> = [];
    const machine = new ReceiverMachine({
      onGapEvent: (event) => {
        gapEvents.push({
          type: event.type,
          expectedSeq: event.expectedSeq,
          receivedSeq: event.receivedSeq,
          gapSize: event.gapSize,
          permanentlyLost: event.permanentlyLost,
          retransmitRequested: event.retransmitRequested,
          streamId: event.streamId
        });
      }
    });

    const transfer = chunkFile(new Uint8Array([1, 2, 3, 4, 5, 6]), { fileName: 'gaps-events.bin', maxPayloadSize: 2, includeEndFrame: true });
    machine.startScanning();
    confirmHeaderLock(machine, transfer.header, 1);

    machine.applyFrame(transfer.dataFrames[2], 10); // detect 0-1 gap
    machine.applyFrame(transfer.dataFrames[0], 11); // fill 0, leave 1
    machine.applyFrame(transfer.endFrame!, 12);
    machine.tick(12 + RECEIVER_TIMEOUTS.END_GRACE_MS + 1);

    expect(gapEvents[0]).toMatchObject({
      type: 'gap_detected',
      expectedSeq: 0,
      receivedSeq: 2,
      gapSize: 2,
      permanentlyLost: false,
      retransmitRequested: false
    });
    expect(gapEvents[1]).toMatchObject({
      type: 'gap_filled',
      expectedSeq: 0,
      receivedSeq: 0,
      gapSize: 2,
      permanentlyLost: false,
      retransmitRequested: false
    });
    expect(gapEvents[2]).toMatchObject({
      type: 'gap_detected',
      expectedSeq: 1,
      receivedSeq: 0,
      gapSize: 1,
      permanentlyLost: false,
      retransmitRequested: false
    });
    expect(gapEvents[3]).toMatchObject({
      type: 'gap_lost',
      expectedSeq: 1,
      gapSize: 1,
      permanentlyLost: true,
      retransmitRequested: false
    });
    expect(gapEvents.every((event) => event.streamId === machine.snapshot.transferId)).toBe(true);
  });

  it('ignores END from wrong transferId', () => {
    const machine = new ReceiverMachine();
    const transferA = chunkFile(new Uint8Array([1, 2, 3, 4]), { fileName: 'a.bin', maxPayloadSize: 2, includeEndFrame: true });
    const transferB = chunkFile(new Uint8Array([9]), { fileName: 'b.bin', maxPayloadSize: 1, includeEndFrame: true });
    machine.startScanning();
    confirmHeaderLock(machine, transferA.header, 1);
    machine.applyFrame(transferA.dataFrames[0], 2);
    const snapshot = machine.applyFrame(transferB.endFrame!, 3);

    expect(snapshot.state).toBe('RECEIVING');
    expect(snapshot.endSeenAt).toBeNull();
  });

  it('handles zero timestamps for timeout bookkeeping', () => {
    const machine = new ReceiverMachine();
    const transfer = chunkFile(new Uint8Array([1, 2, 3]), { fileName: 'zero-time.bin', maxPayloadSize: 2, includeEndFrame: true });
    machine.startScanning();
    confirmHeaderLock(machine, transfer.header, 0);

    const snapshot = machine.tick(RECEIVER_TIMEOUTS.NO_UNIQUE_PROGRESS_TIMEOUT_MS + RECEIVER_LOCK_CONFIRMATION.REQUIRED_HEADERS);
    expect(snapshot.state).toBe('ERROR');
    expect(snapshot.error?.code).toBe(RECEIVER_ERROR_CODES.NO_PROGRESS_TIMEOUT);
  });

  it('fails when END arrives and transfer remains incomplete past grace window', () => {
    const machine = new ReceiverMachine();
    const transfer = chunkFile(new Uint8Array([1, 2, 3, 4]), { fileName: 'x.bin', maxPayloadSize: 2, includeEndFrame: true });
    machine.startScanning();
    confirmHeaderLock(machine, transfer.header, 100);
    machine.applyFrame(transfer.dataFrames[0], 150);
    machine.applyFrame(transfer.endFrame!, 200);

    const snapshot = machine.tick(200 + RECEIVER_TIMEOUTS.END_GRACE_MS + 1);
    expect(snapshot.state).toBe('ERROR');
    expect(snapshot.error?.code).toBe(RECEIVER_ERROR_CODES.END_INCOMPLETE);
  });


  it('non-empty success does not require END once full packet set verifies', () => {
    const machine = new ReceiverMachine();
    const transfer = chunkFile(new Uint8Array([1, 2, 3]), { fileName: 'no-end.bin', maxPayloadSize: 3, includeEndFrame: true });
    machine.startScanning();

    confirmHeaderLock(machine, transfer.header, 1);
    const snapshot = machine.applyFrame(transfer.dataFrames[0], 2);

    expect(snapshot.state).toBe('SUCCESS');
    expect(snapshot.fileBytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(snapshot.endSeenAt).toBeNull();
  });
  it('requires END for zero-byte success', () => {
    const machine = new ReceiverMachine();
    const transfer = chunkFile(new Uint8Array(), { fileName: 'empty.bin', maxPayloadSize: 4, includeEndFrame: true });
    machine.startScanning();

    confirmHeaderLock(machine, transfer.header, 1);

    const afterEnd = machine.applyFrame(transfer.endFrame!, 2);
    expect(afterEnd.state).toBe('SUCCESS');
    expect(afterEnd.fileBytes?.length).toBe(0);
  });

  it('requires transferId in data frames', () => {
    const transferId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const transfer = chunkFile(new Uint8Array([7]), { fileName: 'req.bin', transferId, includeEndFrame: true });
    const validData = assembleFrame(transfer.dataFrames[0]);
    const missingTransferId = new Uint8Array(validData.length - 8);
    missingTransferId.set(validData.slice(0, 5), 0);
    missingTransferId.set(validData.slice(13), 5);

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
    confirmHeaderLock(machine, badHeader, 1);
    const snapshot = machine.applyFrame(transfer.dataFrames[0], 2);

    expect(snapshot.state).toBe('ERROR');
    expect(snapshot.error?.code).toBe(RECEIVER_ERROR_CODES.FILE_CRC_MISMATCH);
  });

  it('ignores out-of-range packet indexes', () => {
    const machine = new ReceiverMachine();
    const transfer = chunkFile(new Uint8Array([1, 2, 3]), { fileName: 'bounds.bin', maxPayloadSize: 3, includeEndFrame: true });
    machine.startScanning();
    confirmHeaderLock(machine, transfer.header, 1);

    const outOfRange: TransferDataFrame = {
      ...transfer.dataFrames[0],
      frameType: FRAME_TYPE_DATA,
      packetIndex: 10,
      payloadLen: transfer.dataFrames[0].payload.length
    };

    const snapshot = machine.applyFrame(outOfRange, 2);
    expect(snapshot.receivedCount).toBe(0);
    expect(snapshot.state).toBe('RECEIVING');
  });

  it('conflicting HEADER detects fileSize mismatch', () => {
    const machine = new ReceiverMachine();
    machine.startScanning();

    const transfer = chunkFile(new Uint8Array([1, 2, 3]), { fileName: 'a.bin', maxPayloadSize: 2, includeEndFrame: true });
    confirmHeaderLock(machine, transfer.header, 1);

    const conflictingHeader: TransferHeaderFrame = {
      ...transfer.header,
      fileSize: transfer.header.fileSize + 1
    };

    const snapshot = machine.applyFrame(conflictingHeader, 2);
    expect(snapshot.state).toBe('ERROR');
    expect(snapshot.error?.code).toBe(RECEIVER_ERROR_CODES.HEADER_CONFLICT);
  });

  it('conflicting HEADER detects totalPackets mismatch', () => {
    const machine = new ReceiverMachine();
    machine.startScanning();

    const transfer = chunkFile(new Uint8Array([1, 2, 3]), { fileName: 'a.bin', maxPayloadSize: 2, includeEndFrame: true });
    confirmHeaderLock(machine, transfer.header, 1);

    const conflictingHeader: TransferHeaderFrame = {
      ...transfer.header,
      totalPackets: transfer.header.totalPackets + 1
    };

    const snapshot = machine.applyFrame(conflictingHeader, 2);
    expect(snapshot.state).toBe('ERROR');
    expect(snapshot.error?.code).toBe(RECEIVER_ERROR_CODES.HEADER_CONFLICT);
  });

  it('conflicting HEADER detects fileCrc32 mismatch', () => {
    const machine = new ReceiverMachine();
    machine.startScanning();

    const transfer = chunkFile(new Uint8Array([1, 2, 3]), { fileName: 'a.bin', maxPayloadSize: 2, includeEndFrame: true });
    confirmHeaderLock(machine, transfer.header, 1);

    const conflictingHeader: TransferHeaderFrame = {
      ...transfer.header,
      fileCrc32: (transfer.header.fileCrc32 + 1) >>> 0
    };

    const snapshot = machine.applyFrame(conflictingHeader, 2);
    expect(snapshot.state).toBe('ERROR');
    expect(snapshot.error?.code).toBe(RECEIVER_ERROR_CODES.HEADER_CONFLICT);
  });

  it('repeated matching HEADER is explicit no-op', () => {
    const machine = new ReceiverMachine();
    machine.startScanning();

    const transfer = chunkFile(new Uint8Array([1, 2, 3]), { fileName: 'same.bin', maxPayloadSize: 2, includeEndFrame: true });
    const first = machine.applyFrame(transfer.header, 1);
    const second = machine.applyFrame(transfer.header, 2);
    const third = machine.applyFrame(transfer.header, 3);

    expect(first.state).toBe('SCANNING');
    expect(second.state).toBe('SCANNING');
    expect(third.state).toBe('RECEIVING');
    expect(second.transferId).toBe(first.transferId);
    expect(second.totalScans).toBe(first.totalScans + 1);
    expect(second.receivedCount).toBe(0);
  });

  it('repeated matching END is explicit no-op', () => {
    const machine = new ReceiverMachine();
    machine.startScanning();

    const transfer = chunkFile(new Uint8Array([1, 2, 3]), { fileName: 'same.bin', maxPayloadSize: 2, includeEndFrame: true });
    confirmHeaderLock(machine, transfer.header, 1);
    machine.applyFrame(transfer.endFrame!, 2);
    const second = machine.applyFrame(transfer.endFrame!, 3);

    expect(second.state).toBe('RECEIVING');
    expect(second.endSeenAt).toBe(3);
  });

  it('ignores END before HEADER', () => {
    const machine = new ReceiverMachine();
    machine.startScanning();

    const transfer = chunkFile(new Uint8Array([1]), { fileName: 'x.bin', maxPayloadSize: 1, includeEndFrame: true });
    const snapshot = machine.applyFrame(transfer.endFrame!, 1);

    expect(snapshot.state).toBe('SCANNING');
    expect(snapshot.transferId).toBeNull();
  });


  it('terminal ERROR blocks further frames across multiple error classes', () => {
    const baseTransfer = chunkFile(new Uint8Array([1, 2, 3]), { fileName: 'err.bin', maxPayloadSize: 2, includeEndFrame: true });

    const scenarios: Array<{ name: string; trigger(machine: ReceiverMachine): void }> = [
      {
        name: 'HEADER_CONFLICT',
        trigger: (machine) => {
          confirmHeaderLock(machine, baseTransfer.header, 1);
          machine.applyFrame({ ...baseTransfer.header, totalPackets: baseTransfer.header.totalPackets + 1 }, 2);
        }
      },
      {
        name: 'FILE_CRC_MISMATCH',
        trigger: (machine) => {
          confirmHeaderLock(machine, { ...baseTransfer.header, fileCrc32: (baseTransfer.header.fileCrc32 + 1) >>> 0 }, 1);
          machine.applyFrame(baseTransfer.dataFrames[0], 2);
          machine.applyFrame(baseTransfer.dataFrames[1], 3);
        }
      },
      {
        name: 'FILE_SIZE_MISMATCH',
        trigger: (machine) => {
          confirmHeaderLock(machine, { ...baseTransfer.header, fileSize: baseTransfer.header.fileSize + 2 }, 1);
          machine.applyFrame(baseTransfer.dataFrames[0], 2);
          machine.applyFrame(baseTransfer.dataFrames[1], 3);
        }
      },
      {
        name: 'END_INCOMPLETE',
        trigger: (machine) => {
          confirmHeaderLock(machine, baseTransfer.header, 1);
          machine.applyFrame(baseTransfer.dataFrames[0], 2);
          machine.applyFrame(baseTransfer.endFrame!, 3);
          machine.tick(3 + RECEIVER_TIMEOUTS.END_GRACE_MS + 1);
        }
      },
      {
        name: 'NO_PROGRESS_TIMEOUT',
        trigger: (machine) => {
          confirmHeaderLock(machine, baseTransfer.header, 1);
          machine.applyFrame(baseTransfer.dataFrames[0], 2);
          machine.tick(2 + RECEIVER_TIMEOUTS.NO_UNIQUE_PROGRESS_TIMEOUT_MS + 1);
        }
      }
    ];

    for (const scenario of scenarios) {
      const machine = new ReceiverMachine();
      machine.startScanning();
      scenario.trigger(machine);
      expect(machine.snapshot.state, scenario.name).toBe('ERROR');

      const transfer = chunkFile(new Uint8Array([7, 8]), { fileName: 'later.bin', maxPayloadSize: 2, includeEndFrame: true });
      const totalBefore = machine.snapshot.totalScans;
      const after = machine.applyFrame(transfer.header, 99);
      expect(after.state, `${scenario.name}-post`).toBe('ERROR');
      expect(after.totalScans, `${scenario.name}-scan-count`).toBe(totalBefore);
    }
  });

  it('terminal ERROR blocks further ingestion', () => {
    const machine = new ReceiverMachine();
    machine.startScanning();

    const transfer = chunkFile(new Uint8Array([1, 2, 3]), { fileName: 'a.bin', maxPayloadSize: 2, includeEndFrame: true });
    confirmHeaderLock(machine, transfer.header, 1);
    const conflictingHeader: TransferHeaderFrame = { ...transfer.header, fileName: 'conflict.bin' };
    const errored = machine.applyFrame(conflictingHeader, 2);
    expect(errored.state).toBe('ERROR');

    const after = machine.applyFrame(transfer.dataFrames[0], 3);
    expect(after.state).toBe('ERROR');
    expect(after.receivedCount).toBe(0);
  });

  it('full-file CRC verification ignores metadata changes', () => {
    const machine = new ReceiverMachine();
    machine.startScanning();

    const bytes = new Uint8Array([8, 9, 10, 11]);
    const transferA = chunkFile(bytes, { fileName: 'a.bin', maxPayloadSize: 2, includeEndFrame: true });
    const transferB = chunkFile(bytes, { fileName: 'different-name.bin', transferId: transferA.header.transferId, maxPayloadSize: 2, includeEndFrame: true });

    confirmHeaderLock(machine, transferB.header, 1);
    machine.applyFrame(transferA.dataFrames[0], 2);
    const snapshot = machine.applyFrame(transferA.dataFrames[1], 3);

    expect(snapshot.state).toBe('SUCCESS');
    expect(snapshot.fileBytes).toEqual(bytes);
  });


  it('exposes explicit receiver transition map', () => {
    expect(RECEIVER_STATE_TRANSITIONS.IDLE).toContain('SCANNING');
    expect(RECEIVER_STATE_TRANSITIONS.VERIFYING).toContain('SUCCESS');
    expect(RECEIVER_STATE_TRANSITIONS.ERROR).toContain('IDLE');
  });

  it('reset transitions to fresh IDLE state after terminal outcomes', () => {
    const machine = new ReceiverMachine();
    const transfer = chunkFile(new Uint8Array([1, 2, 3]), { fileName: 'fresh.bin', maxPayloadSize: 2, includeEndFrame: true });

    machine.startScanning();
    confirmHeaderLock(machine, transfer.header, 1);
    machine.applyFrame(transfer.dataFrames[0], 2);
    const success = machine.applyFrame(transfer.dataFrames[1], 3);
    expect(success.state).toBe('SUCCESS');

    machine.reset();
    expect(machine.snapshot.state).toBe('IDLE');
    expect(machine.snapshot.transferId).toBeNull();
    expect(machine.snapshot.receivedCount).toBe(0);

    machine.startScanning();
    confirmHeaderLock(machine, transfer.header, 10);
    machine.applyFrame({ ...transfer.header, fileName: 'conflict.bin' }, 11);
    expect(machine.snapshot.state).toBe('ERROR');

    machine.reset();
    expect(machine.snapshot.state).toBe('IDLE');
    expect(machine.snapshot.error).toBeUndefined();
  });
});
