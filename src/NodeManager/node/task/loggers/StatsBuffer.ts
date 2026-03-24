import { TaskStat } from '../TaskManager.js';

export class StatsBuffer {
  private readonly buffer: TaskStat[] = new Array((24 * 60 * 60) / 5); // 24 hours of stats at 5s intervals

  push(stat: TaskStat): void {
    this.buffer.push(stat);
  }

  get length(): number {
    return this.buffer.length;
  }

  at(i: number): TaskStat | undefined {
    return this.buffer[i];
  }

  latest(): TaskStat | undefined {
    return this.buffer[this.buffer.length - 1];
  }

  query(start?: number, end?: number, intervalMs?: number): TaskStat[] {
    if (this.buffer.length === 0) return [];

    let slice = this.buffer;

    if (start !== undefined || end !== undefined) {
      const fromIdx = start !== undefined
        ? this.bsearch(start, false)
        : 0;
      if (fromIdx >= this.buffer.length) return [];

      const toIdx = end !== undefined
        ? this.bsearch(end, true)
        : this.buffer.length;
      if (toIdx <= fromIdx) return [];

      slice = this.buffer.slice(fromIdx, toIdx);
    }

    if (!intervalMs) return slice;

    const result: TaskStat[] = [];
    let lastTimestamp = 0;

    for (const stat of slice) {
      if (stat.timestamp - lastTimestamp >= intervalMs) {
        lastTimestamp = stat.timestamp;
        result.push(stat);
      }
    }

    return result;
  }

  private bsearch(timestamp: number, inclusive: boolean): number {
    let lo = 0;
    let hi = this.buffer.length;

    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const cmp = inclusive
        ? this.buffer[mid].timestamp <= timestamp
        : this.buffer[mid].timestamp < timestamp;
      if (cmp) lo = mid + 1;
      else hi = mid;
    }

    return lo;
  }

  toArray(): TaskStat[] {
    return [...this.buffer];
  }
}
