import { describe, expect, it } from 'vitest';
import { RECEIVER_ERROR_CODES, ReceiverMachine, assembleFrame, chunkFile } from '@qr-data-bridge/protocol';
import { buildTransmissionFrames } from './senderCore';
import { ReceiverIngestService } from '../../receiver/src/ingestService';

describe('sender -> receiver e2e integration', () => {
  it('transmits sender-built frames through receiver ingest queue to SUCCESS', async () => {
    const fileBytes = new TextEncoder().encode('sender generated payload for receiver ingestion');
    const { frames, totalDataPackets } = buildTransmissionFrames(fileBytes, 'sender-e2e.txt', 7);

    const machine = new ReceiverMachine();
    machine.startScanning();
    const ingest = new ReceiverIngestService({ machine });

    let now = 1_000;
    let snapshot = machine.snapshot;
    for (const frame of frames) {
      const result = await ingest.enqueue(assembleFrame(frame), now);
      if (result) snapshot = result;
      now += 100;
    }

    expect(totalDataPackets).toBeGreaterThan(0);
    expect(snapshot.state).toBe('SUCCESS');
    expect(snapshot.fileName).toBe('sender-e2e.txt');
    expect(snapshot.fileBytes).toEqual(fileBytes);

    const diagnostics = ingest.getDiagnostics();
    expect(diagnostics.acceptedFrames).toBe(frames.length);
    expect(diagnostics.malformedPayloads).toBe(0);
    expect(diagnostics.badPacketCrcFrames).toBe(0);
    expect(diagnostics.finalizeDurationMs).not.toBeNull();
  });

  it('completes sender zero-byte transfer with deterministic HEADER -> END flow', async () => {
    const { frames, totalDataPackets } = buildTransmissionFrames(new Uint8Array(), 'empty.bin', 256);

    expect(totalDataPackets).toBe(0);
    expect(frames).toHaveLength(2);

    const machine = new ReceiverMachine();
    machine.startScanning();
    const ingest = new ReceiverIngestService({ machine });

    await ingest.enqueue(assembleFrame(frames[0]), 2_000);
    await ingest.enqueue(assembleFrame(frames[1]), 2_100);

    const snapshot = machine.snapshot;
    expect(snapshot.state).toBe('SUCCESS');
    expect(snapshot.fileName).toBe('empty.bin');
    expect(snapshot.fileBytes).toEqual(new Uint8Array());
  });

  it('records bad-packet CRC frames and still succeeds when valid frame follows', async () => {
    const { frames } = buildTransmissionFrames(new Uint8Array([1, 2, 3, 4]), 'crc-recovery.bin', 2);

    const machine = new ReceiverMachine();
    machine.startScanning();
    const ingest = new ReceiverIngestService({ machine, scannerDedupeWindowMs: 0 });

    const headerWire = assembleFrame(frames[0]);
    const firstDataWire = assembleFrame(frames[1]);
    const secondDataWire = assembleFrame(frames[2]);
    const endWire = assembleFrame(frames[3]);

    const corruptedFirstData = firstDataWire.slice();
    corruptedFirstData[17] ^= 0xff;

    await ingest.enqueue(headerWire, 3_000);
    await ingest.enqueue(corruptedFirstData, 3_100);
    await ingest.enqueue(secondDataWire, 3_200);
    await ingest.enqueue(firstDataWire, 3_300);
    await ingest.enqueue(endWire, 3_400);

    const snapshot = machine.snapshot;
    expect(snapshot.state).toBe('SUCCESS');
    expect(snapshot.fileBytes).toEqual(new Uint8Array([1, 2, 3, 4]));

    const diagnostics = ingest.getDiagnostics();
    expect(diagnostics.badPacketCrcFrames).toBeGreaterThanOrEqual(1);
  });

  it('handles scanner duplicates/noise while still completing transfer from sender frames', async () => {
    const fileBytes = new Uint8Array([10, 20, 30, 40, 50, 60]);
    const { frames } = buildTransmissionFrames(fileBytes, 'dedupe.bin', 2);

    const machine = new ReceiverMachine();
    machine.startScanning();
    const ingest = new ReceiverIngestService({ machine, scannerDedupeWindowMs: 5_000 });

    let now = 5_000;
    await ingest.enqueue(new TextEncoder().encode('not-a-protocol-payload'), now);

    const firstFrameBytes = assembleFrame(frames[0]);
    await ingest.enqueue(firstFrameBytes, now + 50);
    await ingest.enqueue(firstFrameBytes, now + 100);

    for (const frame of frames.slice(1)) {
      now += 100;
      await ingest.enqueue(assembleFrame(frame), now);
    }

    const snapshot = machine.snapshot;
    expect(snapshot.state).toBe('SUCCESS');
    expect(snapshot.fileBytes).toEqual(fileBytes);

    const diagnostics = ingest.getDiagnostics();
    expect(diagnostics.nonProtocolPayloads).toBe(1);
    expect(diagnostics.duplicateScannerPayloads).toBeGreaterThanOrEqual(1);
  });

  it('counts foreign frames when another sender stream is visible during active transfer', async () => {
    const transferA = buildTransmissionFrames(new Uint8Array([1, 2, 3, 4]), 'a.bin', 2);
    const transferB = chunkFile(new Uint8Array([7, 7, 7, 7]), { fileName: 'b.bin', maxPayloadSize: 2, includeEndFrame: true });

    const machine = new ReceiverMachine();
    machine.startScanning();
    const ingest = new ReceiverIngestService({ machine });

    let now = 10_000;
    await ingest.enqueue(assembleFrame(transferA.frames[0]), now);
    await ingest.enqueue(assembleFrame(transferB.header), now + 50);
    await ingest.enqueue(assembleFrame(transferB.dataFrames[0]), now + 100);

    for (const frame of transferA.frames.slice(1)) {
      now += 100;
      await ingest.enqueue(assembleFrame(frame), now);
    }

    const snapshot = machine.snapshot;
    expect(snapshot.state).toBe('SUCCESS');
    expect(snapshot.fileName).toBe('a.bin');

    const diagnostics = ingest.getDiagnostics();
    expect(diagnostics.foreignTransferFrames).toBeGreaterThanOrEqual(2);
  });

  it('surfaces END_INCOMPLETE timeout when sender stream terminates early', async () => {
    const { frames } = buildTransmissionFrames(new Uint8Array([9, 8, 7, 6]), 'incomplete.bin', 2);

    const machine = new ReceiverMachine();
    machine.startScanning();
    const ingest = new ReceiverIngestService({ machine });

    await ingest.enqueue(assembleFrame(frames[0]), 20_000);
    await ingest.enqueue(assembleFrame(frames[1]), 20_100);
    await ingest.enqueue(assembleFrame(frames.at(-1)!), 20_200);

    const timeoutSnapshot = machine.tick(22_300);
    expect(timeoutSnapshot.state).toBe('ERROR');
    expect(timeoutSnapshot.error?.code).toBe(RECEIVER_ERROR_CODES.END_INCOMPLETE);
  });
});
