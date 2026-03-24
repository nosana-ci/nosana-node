import WebSocket from 'ws';

import { StatsBuffer } from './StatsBuffer.js';
import TaskManager, { type TaskStat } from '../TaskManager.js';

export function addStat(this: TaskManager, stat: TaskStat) {
  if (!this.opStatBuffers.has(stat.opId)) {
    this.opStatBuffers.set(stat.opId, new StatsBuffer());
  }

  const buffer = this.opStatBuffers.get(stat.opId)!;
  buffer.push(stat);

  for (const ws of this.statSubscribers) {
    const matcher = this.statMatchers.get(ws);
    if (matcher && matcher(stat)) {
      try {
        ws.send(JSON.stringify({ path: 'fstat', data: stat }));
      } catch (_) { }
    }
  }
}

export function getStatsByOp(this: TaskManager, opId: string): TaskStat[] {
  return this.opStatBuffers.get(opId)?.toArray() || [];
}

export function getAllStats(this: TaskManager): TaskStat[] {
  return Array.from(this.opStatBuffers.values()).flatMap((b) => b.toArray());
}

export function queryStats(
  this: TaskManager,
  start?: number,
  end?: number,
  intervalMs?: number,
): TaskStat[] {
  return Array.from(this.opStatBuffers.values()).flatMap((b) => b.query(start, end, intervalMs));
}

export function getLatestStatPerOp(this: TaskManager, since: number): TaskStat[] {
  return Array.from(this.opStatBuffers.values())
    .map((b) => b.latest())
    .filter((s): s is TaskStat => s !== undefined && s.timestamp > since);
}

export function subscribeStats(
  this: TaskManager,
  ws: WebSocket,
  matcher: (stat: TaskStat) => boolean,
) {
  this.statSubscribers.add(ws);
  this.statMatchers.set(ws, matcher);

  ws.on('close', () => {
    unsubscribeStats.call(this, ws);
  });
}

export function unsubscribeStats(this: TaskManager, ws: WebSocket) {
  this.statSubscribers.delete(ws);
  this.statMatchers.delete(ws);
}
