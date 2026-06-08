import type { OperationResults, Log } from '@nosana/sdk';
import { parseLogFrames } from '../../provider/utils/parseBuffer.js';
import {
  createResultsObject,
  extractResultFromLog,
} from './extractResultsFromLogs.js';

export function extractLogsAndResultsFromLogBuffer(
  logBuffer: Buffer,
  operationResults: OperationResults | undefined,
): {
  logs: Log[];
  results: {} | undefined;
} {
  const results: {} | undefined = operationResults
    ? createResultsObject(operationResults)
    : undefined;

  const { logs } = parseLogFrames(logBuffer);

  if (results && operationResults) {
    for (const log of logs) {
      extractResultFromLog(results, log, operationResults);
    }
  }

  return { logs, results };
}
