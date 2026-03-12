import { describe, expect, it } from 'vitest';
import {
  ReceiverMachine,
  RECEIVER_LOCK_CONFIRMATION,
  assembleFrame,
  calculateCRC32,
  chunkFile,
  type TransferDataFrame
} from '@qr-data-bridge/protocol';
import { ReceiverIngestService } from './ingestService';

function mutatePacketCrc(frame: TransferDataFrame): Uint8Array {
  const bytes = assembleFrame(frame);
  const mutated = bytes.slice();
  const payloadOffset = 4 + 1 + 8 + 2 + 2;
  const payloadLen = (mutated[15] << 8) | mutated[16];
  const payload = mutated.slice(payloadOffset, payloadOffset + payloadLen);
  const crc = calculateCRC32(Uint8Array.of(...frame.transferId, ...new Uint8Array([(frame.packetIndex >> 8) & 0xff, frame.packetIndex & 0xff]), ...payload));
  const wrong = (crc ^ 0xffffffff) >>> 0;
  const crcOffset = payloadOffset + payloadLen;
  mutated[crcOffset] = (wrong >>> 24) & 0xff;
  mutated[crcOffset + 1] = (wrong >>> 16) & 0xff;
  mutated[crcOffset + 2] = (wrong >>> 8) & 0xff;
  mutated[crcOffset + 3] = wrong & 0xff;
  return mutated;
}


function ingestHeaderConfirmations(service: ReceiverIngestService, headerPayload: Uint8Array, startAt: number): void {
  for (let i = 0; i < RECEIVER_LOCK_CONFIRMATION.REQUIRED_HEADERS; i += 1) {
    service.ingest(headerPayload, startAt + i);
  }
}

describe('ReceiverIngestService', () => {
  it('separates scanner dedupe from protocol dedupe and tracks diagnostics', () => {
    const machine = new ReceiverMachine();
    machine.startScanning();

    const events: string[] = [];
    const service = new ReceiverIngestService({
      machine,
      onEvent: (event) => events.push(event.type)
    });

    const transfer = chunkFile(new Uint8Array([1, 2, 3, 4]), {
      fileName: 'a.bin',
      maxPayloadSize: 2,
      includeEndFrame: true
    });

    const headerPayload = assembleFrame(transfer.header);
    ingestHeaderConfirmations(service, headerPayload, 1000);

    const dataPayload1 = assembleFrame(transfer.dataFrames[0]);
    const dataPayload1Duplicate = assembleFrame(transfer.dataFrames[0]);

    service.ingest(dataPayload1, 1010);
    service.ingest(dataPayload1Duplicate, 1020);

    const remappedFrame: TransferDataFrame = {
      ...transfer.dataFrames[0],
      payload: transfer.dataFrames[0].payload.slice()
    };
    const dataPayload1DifferentWrapper = assembleFrame(remappedFrame);
    service.ingest(dataPayload1DifferentWrapper, 6000);

    const diagnostics = service.getDiagnostics();
    expect(diagnostics.totalPayloadsSeen).toBe(6);
    expect(diagnostics.duplicateScannerPayloads).toBe(1);
    expect(diagnostics.acceptedFrames).toBe(4);
    expect(events).toContain('duplicateScannerPayload');
  });

  it('tracks foreign transfer frames ignored after lock', () => {
    const machine = new ReceiverMachine();
    machine.startScanning();
    const service = new ReceiverIngestService({
      machine
    });

    const transfer = chunkFile(new Uint8Array([1, 2, 3, 4]), { fileName: 'a.bin', maxPayloadSize: 2, includeEndFrame: true });
    const foreign = chunkFile(new Uint8Array([9, 9, 9, 9]), { fileName: 'b.bin', maxPayloadSize: 2, includeEndFrame: true });

    ingestHeaderConfirmations(service, assembleFrame(transfer.header), 1010);
    service.ingest(assembleFrame(foreign.dataFrames[0]), 1020);

    const diagnostics = service.getDiagnostics();
    expect(diagnostics.foreignTransferFrames).toBe(1);
    expect(diagnostics.acceptedFrames).toBe(RECEIVER_LOCK_CONFIRMATION.REQUIRED_HEADERS);
  });



  it('drops replayed data sequence numbers for locked session and logs tuple metadata', () => {
    const machine = new ReceiverMachine();
    machine.startScanning();
    const dropped: string[] = [];
    const accepted: string[] = [];
    const service = new ReceiverIngestService({
      machine,
      scannerDedupeWindowMs: 0,
      onEvent: (event) => {
        if (event.type === 'frameDropped') dropped.push(`${event.reason}:${event.tuple.sessionId}:${event.tuple.streamId}:${event.tuple.seq}`);
        if (event.type === 'frameAccepted') accepted.push(`${event.tuple.sessionId}:${event.tuple.streamId}:${event.tuple.seq}`);
      }
    });

    const transfer = chunkFile(new Uint8Array([1, 2, 3, 4]), { fileName: 'a.bin', maxPayloadSize: 2, includeEndFrame: true });
    const headerPayload = assembleFrame(transfer.header);
    ingestHeaderConfirmations(service, headerPayload, 1000);

    const packet0 = transfer.dataFrames[0];
    const replayedPacket0DifferentPayload: TransferDataFrame = {
      ...packet0,
      payload: transfer.dataFrames[1].payload.slice(),
      payloadLen: transfer.dataFrames[1].payloadLen,
      packetCrc32: calculateCRC32(Uint8Array.of(...packet0.transferId, ...new Uint8Array([(packet0.packetIndex >> 8) & 0xff, packet0.packetIndex & 0xff]), ...transfer.dataFrames[1].payload))
    };

    service.ingest(assembleFrame(packet0), 1010);
    service.ingest(assembleFrame(replayedPacket0DifferentPayload), 1011);

    expect(accepted).toContain(`${machine.snapshot.transferId}:DATA:0`);
    expect(dropped.some((entry) => entry.includes('replayedSequence') && entry.endsWith(':DATA:0'))).toBe(true);
  });

  it('resets sequence tracking after a validated new session start lock', () => {
    const machine = new ReceiverMachine();
    machine.startScanning();
    const dropped: string[] = [];
    const service = new ReceiverIngestService({
      machine,
      onEvent: (event) => {
        if (event.type === 'frameDropped') dropped.push(event.reason);
      }
    });

    const transferA = chunkFile(new Uint8Array([1, 2]), { fileName: 'a.bin', maxPayloadSize: 2, includeEndFrame: true });
    ingestHeaderConfirmations(service, assembleFrame(transferA.header), 1000);
    service.ingest(assembleFrame(transferA.dataFrames[0]), 1010);

    machine.startScanning();
    service.reset();

    const transferB = chunkFile(new Uint8Array([9, 8]), { fileName: 'b.bin', maxPayloadSize: 2, includeEndFrame: true });
    ingestHeaderConfirmations(service, assembleFrame(transferB.header), 2000);
    service.ingest(assembleFrame(transferB.dataFrames[0]), 2010);

    expect(machine.snapshot.receivedCount).toBe(1);
    expect(dropped).not.toContain('replayedSequence');
  });


  it('counts malformed/non-protocol payloads independently', () => {
    const machine = new ReceiverMachine();
    machine.startScanning();
    const service = new ReceiverIngestService({
      machine
    });

    const headerPayload = assembleFrame(chunkFile(new Uint8Array([1, 2]), { fileName: 'a.bin', maxPayloadSize: 2, includeEndFrame: true }).header);
    ingestHeaderConfirmations(service, headerPayload, 1000);
    service.ingest(new TextEncoder().encode('not-a-protocol-payload'), 1010);

    const diagnostics = service.getDiagnostics();
    expect(diagnostics.nonProtocolPayloads).toBe(1);
    expect(diagnostics.malformedPayloads).toBe(0);
  });

  it('tracks bad DATA packet CRC as ignorable frame-loss bucket', () => {
    const machine = new ReceiverMachine();
    machine.startScanning();
    const service = new ReceiverIngestService({
      machine
    });

    const transfer = chunkFile(new Uint8Array([1, 2]), { fileName: 'a.bin', maxPayloadSize: 2, includeEndFrame: true });
    const headerPayload = assembleFrame(transfer.header);
    const packetPayload = assembleFrame(transfer.dataFrames[0]);
    const badCrcPayload = mutatePacketCrc(transfer.dataFrames[0]);

    ingestHeaderConfirmations(service, headerPayload, 1000);
    service.ingest(packetPayload, 1010);
    service.ingest(badCrcPayload, 6000);

    const diagnostics = service.getDiagnostics();
    expect(diagnostics.badPacketCrcFrames).toBe(1);
    expect(diagnostics.malformedPayloads).toBe(0);
  });

  it('records finalize duration once on success event', async () => {
    const machine = new ReceiverMachine();
    machine.startScanning();
    const durations: number[] = [];

    const service = new ReceiverIngestService({
      machine,
      onEvent: (event) => {
        if (event.type === 'completed') durations.push(event.durationMs);
      }
    });

    const transfer = chunkFile(new Uint8Array([1, 2, 3]), { fileName: 'a.bin', maxPayloadSize: 2, includeEndFrame: true });

    const headerPayload = assembleFrame(transfer.header);
    const data0Payload = assembleFrame(transfer.dataFrames[0]);
    const data1Payload = assembleFrame(transfer.dataFrames[1]);

    for (let i = 0; i < RECEIVER_LOCK_CONFIRMATION.REQUIRED_HEADERS; i += 1) {
      await service.enqueue(headerPayload, 1000 + i);
    }
    await service.enqueue(data0Payload, 1010);
    await service.enqueue(data1Payload, 1020);

    const diagnostics = service.getDiagnostics();
    expect(diagnostics.finalizeDurationMs).toBe(20);
    expect(durations).toEqual([20]);
  });


  it('coalesces queued duplicates so unique frames survive overload and complete transfer', async () => {
    const machine = new ReceiverMachine();
    machine.startScanning();
    const service = new ReceiverIngestService({
      machine,
      maxPendingIngestions: 8
    });

    const bytes = new Uint8Array(Array.from({ length: 18 }, (_, i) => i + 1));
    const transfer = chunkFile(bytes, {
      fileName: 'overload.bin',
      maxPayloadSize: 3,
      includeEndFrame: true
    });

    const headerPayload = assembleFrame(transfer.header);
    const duplicateDataPayload = assembleFrame(transfer.dataFrames[0]);
    const uniquePayloads = [
      ...transfer.dataFrames.slice(1).map((frame) => assembleFrame(frame)),
      ...(transfer.endFrame ? [assembleFrame(transfer.endFrame)] : [])
    ];

    for (let i = 0; i < RECEIVER_LOCK_CONFIRMATION.REQUIRED_HEADERS; i += 1) {
      await service.enqueue(headerPayload, 1000 + i);
    }

    await service.enqueue(duplicateDataPayload, 1099);

    const queued: Array<Promise<unknown>> = [];
    let now = 1100;
    for (const uniquePayload of uniquePayloads) {
      for (let i = 0; i < 20; i += 1) {
        queued.push(service.enqueue(duplicateDataPayload, now));
        now += 1;
      }
      queued.push(service.enqueue(uniquePayload, now));
      now += 1;
    }

    await Promise.all(queued);

    const snapshot = machine.snapshot;
    expect(snapshot.state).toBe('SUCCESS');
    expect(snapshot.receivedCount).toBe(transfer.header.totalPackets);

    const diagnostics = service.getDiagnostics();
    expect(diagnostics.duplicateScannerPayloads).toBeGreaterThan(0);
  });

  it('bounds pending ingestion queue to prevent unbounded scan callback growth', async () => {
    const machine = new ReceiverMachine();
    machine.startScanning();
    const service = new ReceiverIngestService({
      machine,
      maxPendingIngestions: 2
    });

    const transfer = chunkFile(new Uint8Array([1, 2, 3, 4]), {
      fileName: 'bounded.bin',
      maxPayloadSize: 2,
      includeEndFrame: true
    });

    const headerPayload = assembleFrame(transfer.header);
    const dataPayload0 = assembleFrame(transfer.dataFrames[0]);
    const dataPayload1 = assembleFrame(transfer.dataFrames[1]);

    const p1 = service.enqueue(headerPayload, 1000);
    const p2 = service.enqueue(dataPayload0, 1010);
    const p3 = service.enqueue(dataPayload1, 1020);

    await Promise.all([p1, p2, p3]);

    const diagnostics = service.getDiagnostics();
    expect(diagnostics.droppedQueuedPayloads).toBe(1);
  });

});
