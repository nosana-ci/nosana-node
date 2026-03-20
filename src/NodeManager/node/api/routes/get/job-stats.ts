import { Response } from 'express';

import { NodeAPIRequest } from '../../types/index.js';
import { parseInterval } from '../../utils/interval.js';
import { TaskManagerRegistry } from '../../../task/TaskManagerRegistry.js';

export function getJobStatsRoute(
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

  const start = req.query.start ? Number(req.query.start) : undefined;
  const end = req.query.end ? Number(req.query.end) : undefined;

  if ((start !== undefined && isNaN(start)) || (end !== undefined && isNaN(end))) {
    res.status(400).send('start and end must be valid timestamps (ms)');
    return;
  }

  const intervalMs = intervalParam * 1000;

  const result = task.queryStats(start, end, intervalMs);

  res.json(result);
}
