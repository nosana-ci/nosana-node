import chalk from 'chalk';

import { sleep } from '../utils/utils.js';
import {
  HostManagerUnreachableError,
  describeNetworkError,
} from '../errors/HostManagerUnreachableError.js';

const MAX_ATTEMPTS = 6;
const BASE_DELAY_S = 1;

/**
 * Custom fetch for openapi-fetch clients that retries network-level failures
 * (errors thrown by fetch itself: DNS, connection resets, timeouts) with
 * exponential backoff. HTTP error responses are returned untouched — those
 * are handled by the callers and the maintenance middleware.
 */
export const retryFetch = async (input: Request): Promise<Response> => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Fetch a clone so the body is still readable on the next attempt.
      return await fetch(input.clone());
    } catch (error) {
      lastError = error;

      if (attempt < MAX_ATTEMPTS) {
        const delayS = BASE_DELAY_S * 2 ** (attempt - 1);
        console.warn(
          chalk.yellow(
            `Request to the host manager failed (${describeNetworkError(error)}), retrying in ${delayS}s (attempt ${attempt}/${MAX_ATTEMPTS})`,
          ),
        );
        await sleep(delayS);
      }
    }
  }

  throw new HostManagerUnreachableError(MAX_ATTEMPTS, lastError);
};
