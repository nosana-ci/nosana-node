/**
 * Exit codes the auto-update wrapper acts on; it stops on any other code.
 * Keep in sync with `auto-update/src/index.ts`.
 */
export const EXIT_CODES = {
  UPDATE: 129,
  UPDATE_IN_JOB_LOOP: 76,
  RESTART: 75,
} as const;

/** Set by the wrapper on the process that replaces a node in the job loop. */
export const IN_JOB_LOOP_ENV = 'NOSANA_NODE_IN_JOB_LOOP';
