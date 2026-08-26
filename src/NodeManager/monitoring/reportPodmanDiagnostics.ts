import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { reportError } from './reportError.js';

const CDI_EVENTS = 'cdi-events.log';
// Enough of the first event to tell one log from another.
const HEAD_BYTES = 64;
// A log this far ahead of us is skipped rather than read into memory at once.
const MAX_CATCH_UP = 1024 * 1024;

/**
 * Forward the events the podman container leaves in the directory the two
 * share. That container has no route to the host manager of its own, so its
 * event log is the only sign of whether the CDI watcher ever fired.
 *
 * Nothing here may throw: this is diagnostics, and the node's uncaught handler
 * would turn a failure to read a log file into the node stopping. Watching can
 * fail outright (a directory that is not there, a host out of inotify watches)
 * and a watch already established still reports errors of its own if the
 * directory it covers is removed.
 */
export function reportPodmanDiagnostics(configLocation: string): void {
  if (!configLocation) return;

  const log = path.join(configLocation.replace(/^~/, os.homedir()), CDI_EVENTS);
  let head = '';
  let drained = 0;
  let partial = '';

  // Only the bytes appended since the last read: the log is never rotated, so
  // re-reading it whole would cost more with every event.
  //
  // Replacement is detected by re-reading the start of the file, which is the
  // only signal that survives it: the log is replaced when the podman container
  // is recreated, and neither size nor inode moves — these events are formulaic
  // enough that the new first line is often exactly as long as the old, and a
  // path recreated at once takes the inode back. The descriptor is opened per
  // read for the same reason: a held one keeps reporting the size of the
  // replaced file and never sees another event.
  const drain = () => {
    let fd: number;
    try {
      fd = fs.openSync(log, 'r');
    } catch {
      return; // not written yet, or gone with the container that wrote it
    }

    try {
      const { size } = fs.fstatSync(fd);
      const start = Buffer.alloc(Math.min(size, HEAD_BYTES));
      fs.readSync(fd, start, 0, start.length, 0);

      // Only the prefix the two have in common: while the log is still shorter
      // than HEAD_BYTES an append lengthens what is read here, which is growth
      // rather than a different file.
      const first = start.toString('utf8');
      const shared = Math.min(first.length, head.length);

      if (first.slice(0, shared) !== head.slice(0, shared) || size < drained) {
        drained = 0;
        partial = '';
      }

      head = first;
      if (size === drained) return;

      // Reading a log that has run far ahead would hold all of it in memory at
      // once; the older events are given up instead.
      if (size - drained > MAX_CATCH_UP) {
        drained = size;
        partial = '';
        return;
      }

      const appended = Buffer.alloc(size - drained);
      fs.readSync(fd, appended, 0, appended.length, drained);
      drained = size;

      // A write can be seen part way through a line; hold the tail until the
      // newline that ends it arrives.
      const lines = (partial + appended.toString('utf8')).split('\n');
      partial = lines.pop() ?? '';
      lines
        .filter(Boolean)
        .forEach((event) =>
          void reportError({
            error_type: 'cdiEvent',
            error_name: 'Event',
            error_message: event,
            error_stack: '',
          }),
        );
    } finally {
      fs.closeSync(fd);
    }
  };

  const drainQuietly = () => {
    try {
      drain();
    } catch {
      // Reported nothing this time; the next event tries again.
    }
  };

  drainQuietly();

  try {
    // The directory, not the file: the file does not exist until the first
    // fault, and a watch on a path that is replaced follows neither file.
    const watcher = fs.watch(path.dirname(log), (_, file) => {
      if (!file || file === CDI_EVENTS) drainQuietly();
    });

    watcher.on('error', () => watcher.close());
    watcher.unref();
  } catch {
    // No watch, so no events are forwarded; the node runs regardless.
  }
}
