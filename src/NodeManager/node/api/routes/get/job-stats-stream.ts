import type { Response } from 'express';

import { parseInterval } from '../../utils/interval.js';
import { createEventSource } from '../../eventsource/index.js';
import { TaskManagerRegistry } from '../../../task/TaskManagerRegistry.js';

import type { NodeAPIRequest } from '../../types/index.js';
import type { TaskStat } from '../../../task/TaskManager.js';

export function getJobStatsStreamRoute(
  req: NodeAPIRequest<{ jobId: string }>,
  res: Response,
) {
  const { jobId } = req.params;

  const intervalParam = parseInterval(req, res);

  if (intervalParam === null) return;

  const task = TaskManagerRegistry.getInstance().get(jobId);

  if (!task) {
    res.status(404).send('Invalid job address');
    return;
  }

  const { sendIfChanged, closeEventSource } =
    createEventSource<TaskStat[]>(req, res);

  const intervalMs = intervalParam * 1000;
  let lastTimestamp = 0;

  const statsInterval = setInterval(() => {
    const stats = task.getLatestStatPerOp(lastTimestamp);
    if (stats.length > 0) {
      sendIfChanged(stats);
      lastTimestamp = Math.max(...stats.map((s) => s.timestamp));
    }
  }, intervalMs);

  const onFlowUpdated = ({ type }: { type: string }) => {
    if (type === 'status:end' || type === 'status:failed') {
      cleanup();
    }
  };

  task.getEventsEmitter().on('flow:updated', onFlowUpdated);

  const cleanup = () => {
    clearInterval(statsInterval);
    task.getEventsEmitter().off('flow:updated', onFlowUpdated);
    closeEventSource();
  };

  req.on('close', cleanup);
}
