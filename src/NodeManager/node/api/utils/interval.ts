import { Response } from 'express';

import { NodeAPIRequest } from '../types/index.js';

export const DEFAULT_INTERVAL = 5;
export const ALLOWED_INTERVALS = [5, 10, 30, 60, 300, 1_800] as const;

export type Interval = (typeof ALLOWED_INTERVALS)[number];

export function validateInterval(value: number): value is Interval {
  return (ALLOWED_INTERVALS as readonly number[]).includes(value);
}

export function parseInterval(
  req: NodeAPIRequest<{ jobId: string }>,
  res: Response,
): Interval | null {
  const raw = Number(req.query.interval ?? DEFAULT_INTERVAL);

  if (!validateInterval(raw)) {
    res
      .status(400)
      .send(
        `Invalid interval. Allowed values (seconds): ${ALLOWED_INTERVALS.join(', ')}`,
      );
    return null;
  }

  return raw;
}
