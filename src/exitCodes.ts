/**
 * How the node asks the auto-update wrapper for another process. Keep in sync
 * with `auto-update/src/index.ts`.
 *
 * The node always leaves with RESPAWN_EXIT_CODE. Every wrapper ever deployed
 * reinstalls and respawns on it, and stops on anything else, so it is the one
 * code that never takes the node down. What the node wanted (an update or a
 * plain restart, in the job loop or not, which version) travels as an
 * `ExitRequest` over IPC when the wrapper opened a channel; wrappers without
 * one treat every exit as an update, which is the old behaviour.
 */
export const RESPAWN_EXIT_CODE = 129;

/** How long the wrapper is given to take the message before leaving anyway. */
const SEND_DEADLINE_MS = 2 * 1000;

/** Set by the wrapper on the process that replaces a node in the job loop. */
export const IN_JOB_LOOP_ENV = 'NOSANA_NODE_IN_JOB_LOOP';

/**
 * Sent to the wrapper before exiting. Add fields freely; a wrapper ignores
 * what it does not know. A wrapper that does not know a `type` treats the
 * exit as an update, so a new type must be safe to handle that way.
 */
export type ExitRequest =
  | { type: 'update'; inJobLoop: boolean; requestedVersion: string }
  | { type: 'restart'; inJobLoop: boolean };

/**
 * Ask the wrapper for another process. Tells it over IPC when there is a
 * channel, then exits with RESPAWN_EXIT_CODE either way. Never resolves.
 */
export function requestExit(request: ExitRequest): Promise<never> {
  return new Promise<never>(() => {
    // Nothing calls back when the channel went with the wrapper.
    setTimeout(() => process.exit(RESPAWN_EXIT_CODE), SEND_DEADLINE_MS);

    if (process.send) {
      // Exiting before the message is flushed can drop it.
      process.send(request, undefined, undefined, () =>
        process.exit(RESPAWN_EXIT_CODE),
      );
    } else {
      process.exit(RESPAWN_EXIT_CODE);
    }
  });
}
