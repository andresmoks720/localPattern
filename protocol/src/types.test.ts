import { describe, expect, it } from 'vitest';
import * as protocol from './index';

describe('protocol frame surface', () => {
  it('exposes only one-way frame type constants (HEADER, DATA, END)', () => {
    expect(protocol.FRAME_TYPE_HEADER).toBeTypeOf('number');
    expect(protocol.FRAME_TYPE_DATA).toBeTypeOf('number');
    expect(protocol.FRAME_TYPE_END).toBeTypeOf('number');
  });

  it('does not export dormant backchannel message constants', () => {
    const exportKeys = Object.keys(protocol);
    const blocked = exportKeys.filter((key) => /(ACK|NACK|BACKCHANNEL|REQUEST|RESPONSE)/i.test(key));
    expect(blocked).toEqual([]);
  });
});
