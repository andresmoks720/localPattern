import { describe, expect, it } from 'vitest';
import { RingBuffer, average, maxValue, percentile } from './BoundedMetrics';

describe('RingBuffer', () => {
  it('keeps capacity bounded and rolls off old entries', () => {
    const buffer = new RingBuffer<number>(3);
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    buffer.push(4);

    expect(buffer.size()).toBe(3);
    expect(buffer.values()).toEqual([2, 3, 4]);
  });

  it('computes summary stats from bounded values', () => {
    const values = [10, 20, 30, 40];
    expect(average(values)).toBe(25);
    expect(percentile(values, 0.95)).toBe(30);
    expect(maxValue(values)).toBe(40);
  });
});
