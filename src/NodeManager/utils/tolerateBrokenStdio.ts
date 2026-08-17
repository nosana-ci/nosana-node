import type { Writable } from 'stream';

/** Errnos that mean the far end is gone rather than the stream misused. */
const TERMINAL_GONE = new Set(['EIO', 'EPIPE', 'ERR_STREAM_DESTROYED']);

/** Whether a write failed because the terminal went away. */
export function isTerminalGone(error: unknown): boolean {
  return TERMINAL_GONE.has((error as NodeJS.ErrnoException)?.code ?? '');
}

/**
 * Ignore writes that fail because the terminal went away — a detached
 * `docker run -t`, a dropped SSH session.
 *
 * tty writes complete after the call returns, and a stream with no `error`
 * listener rethrows, so the failure lands as an uncaughtException wherever the
 * event loop is. Any other stream error is rethrown.
 */
export function tolerateBrokenStdio(
  streams: Writable[] = [process.stdout, process.stderr],
): void {
  for (const stream of streams) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (isTerminalGone(error)) return;
      throw error;
    });
  }
}
