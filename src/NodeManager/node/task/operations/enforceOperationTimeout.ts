import type { EventEmitter } from 'events';

/**
 * Enforces a maximum running time for a single operation.
 *
 * The clock starts when the operation emits `start` (i.e. the container is
 * actually running) — the same lifecycle point the rest of
 * `runTaskManagerOperation` keys its timeout enforcement off. If the operation
 * is still running `timeoutSeconds` later, `onTimeout` is invoked; callers use
 * this to abort the op. The timer is cleared as soon as the operation settles
 * (`exit`/`error`) or is torn down (`end`), so a normally completing op never
 * triggers it.
 *
 * The unit is seconds, matching the on-chain `job.timeout` convention.
 *
 * A missing, zero, or negative timeout disables enforcement (no-op).
 */
export function enforceOperationTimeout(
  emitter: EventEmitter,
  timeoutSeconds: number | undefined,
  onTimeout: () => void,
): void {
  if (!timeoutSeconds || timeoutSeconds <= 0) return;

  let handle: NodeJS.Timeout | undefined;

  const clear = () => {
    if (handle) {
      clearTimeout(handle);
      handle = undefined;
    }
  };

  emitter.on('start', () => {
    // Guard against a second `start` (e.g. a restart) arming a duplicate timer.
    clear();
    handle = setTimeout(() => {
      handle = undefined;
      onTimeout();
    }, timeoutSeconds * 1000);
  });

  emitter.on('exit', clear);
  emitter.on('error', clear);
  emitter.on('end', clear);
}
