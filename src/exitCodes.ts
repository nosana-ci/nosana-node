/**
 * Exit codes the auto-update wrapper acts on; it stops on any other code.
 * Keep in sync with `auto-update/src/index.ts`.
 *
 * Wrappers already deployed only know UPDATE (129); every other code ends
 * them, and with them the node. Until those wrappers are replaced,
 * UPDATE_IN_JOB_LOOP deliberately aliases UPDATE so a node updating from the
 * job loop is respawned rather than dropped. The cost is that the newer
 * wrapper cannot tell the two apart, so the replacement starts fresh instead
 * of resuming the job loop. Restore 76 once old wrappers are gone.
 *
 * RESTART stays distinct: old wrappers exit on it, as they did before it
 * existed, so the outside supervisor takes over; the newer wrapper restarts
 * with backoff. Aliasing it to UPDATE would reinstall on every failure with
 * no delay, and kill pinned wrappers outright.
 */
export const EXIT_CODES = {
  UPDATE: 129,
  UPDATE_IN_JOB_LOOP: 129,
  RESTART: 75,
} as const;

/** Set by the wrapper on the process that replaces a node in the job loop. */
export const IN_JOB_LOOP_ENV = 'NOSANA_NODE_IN_JOB_LOOP';
