import { describe, expect, it } from 'vitest';
import { decideDataFrameHandling, decideTimeoutHandling } from './receiverRules';

describe('receiver rules', () => {
  it('DATA before HEADER ignored', () => {
    expect(
      decideDataFrameHandling({
        headerReceived: false,
        activeTransferId: null,
        totalPackets: null,
        frameTransferId: 'aa',
        packetIndex: 0,
        hasPacket: false
      })
    ).toBe('await-header');
  });

  it('receiver locks to one transferId and wrong-transfer DATA is ignored', () => {
    expect(
      decideDataFrameHandling({
        headerReceived: true,
        activeTransferId: 'active',
        totalPackets: 3,
        frameTransferId: 'other',
        packetIndex: 0,
        hasPacket: false
      })
    ).toBe('wrong-transfer');
  });

  it('duplicate DATA does not corrupt state', () => {
    expect(
      decideDataFrameHandling({
        headerReceived: true,
        activeTransferId: 'active',
        totalPackets: 3,
        frameTransferId: 'active',
        packetIndex: 1,
        hasPacket: true
      })
    ).toBe('duplicate');
  });

  it('out-of-range packet index handling verified', () => {
    expect(
      decideDataFrameHandling({
        headerReceived: true,
        activeTransferId: 'active',
        totalPackets: 3,
        frameTransferId: 'active',
        packetIndex: 3,
        hasPacket: false
      })
    ).toBe('out-of-range');
  });

  it('END with incomplete packet set becomes terminal failure', () => {
    expect(
      decideTimeoutHandling({
        now: 3000,
        headerReceived: true,
        totalPackets: 5,
        receivedPacketsCount: 3,
        endSeenAt: 500,
        lastUniquePacketAt: 1200,
        endGraceWindowMs: 2000,
        noUniqueProgressTimeoutMs: 15000
      })
    ).toBe('incomplete-end');
  });

  it('no unique progress timeout becomes terminal failure', () => {
    expect(
      decideTimeoutHandling({
        now: 20000,
        headerReceived: true,
        totalPackets: 5,
        receivedPacketsCount: 2,
        endSeenAt: null,
        lastUniquePacketAt: 1000,
        endGraceWindowMs: 2000,
        noUniqueProgressTimeoutMs: 15000
      })
    ).toBe('no-unique-progress');
  });

  it('zero-byte file deterministic completion timeout path verified', () => {
    expect(
      decideTimeoutHandling({
        now: 20000,
        headerReceived: true,
        totalPackets: 0,
        receivedPacketsCount: 0,
        endSeenAt: null,
        lastUniquePacketAt: 1000,
        endGraceWindowMs: 2000,
        noUniqueProgressTimeoutMs: 15000
      })
    ).toBe('no-end-zero-byte');
  });
});
