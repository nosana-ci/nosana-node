/**
 * Returns the signal only while it is still active, otherwise `undefined`.
 *
 * docker-modem crashes with an uncaught `AbortError` when handed an
 * already-aborted `AbortSignal`: with a socket path the request is built in a
 * microtask (`getSocketPath().then(...)`), where `addAbortSignal` synchronously
 * destroys the freshly-created `ClientRequest` and emits `'error'` before any
 * handler is attached — an unhandled `'error'` event that takes down the
 * process.
 *
 * Teardown calls (inspect/stop/remove) legitimately run after the op's signal
 * has aborted, so every Docker call must be guarded with this: an active signal
 * is passed through (cancellation still works), while an already-aborted one is
 * dropped so the call runs to completion instead of crashing.
 */
export function liveAbortSignal(
  signal: AbortSignal | undefined,
): AbortSignal | undefined {
  return signal?.aborted ? undefined : signal;
}
