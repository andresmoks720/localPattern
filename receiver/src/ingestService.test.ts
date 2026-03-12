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
    expect(diagnostics.acceptedFrames).toBe(5);
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
    expect(diagnostics.acceptedFrames).toBe(RECEIVER_LOCK_CONFIRMATION.REQUIRED_HEADERS + 1);
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
