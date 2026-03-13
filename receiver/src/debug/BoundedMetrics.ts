export class RingBuffer<T> {
  private readonly data: Array<T | undefined>;

  private nextIndex = 0;

  private filled = 0;

  public constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('RingBuffer capacity must be a positive integer.');
    }
    this.data = new Array<T | undefined>(capacity);
  }

  public push(value: T): void {
    this.data[this.nextIndex] = value;
    this.nextIndex = (this.nextIndex + 1) % this.capacity;
    this.filled = Math.min(this.capacity, this.filled + 1);
  }

  public clear(): void {
    this.data.fill(undefined);
    this.nextIndex = 0;
    this.filled = 0;
  }

  public size(): number {
    return this.filled;
  }

  public values(): T[] {
    if (this.filled === 0) return [];
    const start = this.filled === this.capacity ? this.nextIndex : 0;
    const result: T[] = [];
    for (let i = 0; i < this.filled; i += 1) {
      const value = this.data[(start + i) % this.capacity];
      if (value !== undefined) result.push(value);
    }
    return result;
  }
}

export function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.min(1, Math.max(0, p));
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * clamped));
  return sorted[index];
}

export function maxValue(values: number[]): number {
  return values.length ? Math.max(...values) : 0;
}
