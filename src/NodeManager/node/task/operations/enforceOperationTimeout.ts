import type { EventEmitter } from 'events';

/**
 * Enforces a maximum running time for a single operation.
 *
 * The clock starts on `container:started` — emitted once the container is
 * actually running, i.e. *after* the image pull — so download time is not
 * counted against the operation's allotted run time. (The earlier `start`
 * event, which the provider emits before pulling, is deliberately not used.)
 * If the operation is still running `timeoutSeconds` later, `onTimeout` is
 * invoked; callers use this to abort the op. The timer is cleared as soon as
 * the operation settles (`exit`/`error`) or is torn down (`end`), so a normally
 * completing op never triggers it.
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

  emitter.on('container:started', () => {
    // Defensive: clear first so an unexpected duplicate can't stack timers.
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
