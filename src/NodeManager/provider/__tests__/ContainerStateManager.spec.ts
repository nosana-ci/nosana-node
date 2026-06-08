import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';
import { EventEmitter } from 'events';
import type Dockerode from 'dockerode';

import { ContainerStateManager } from '../ContainerStateManager.js';

/** A readable that stays open and produces nothing until destroyed. */
function openStream(): Readable {
  return new Readable({ read() {} });
}

/** Encode a single Docker multiplexed log frame (non-TTY stream format). */
function frame(type: 'stdout' | 'stderr', payload: string): Buffer {
  const body = Buffer.from(payload, 'utf-8');
  const header = Buffer.alloc(8);
  header.writeUInt8(type === 'stdout' ? 1 : 2, 0);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('ContainerStateManager', () => {
  let unhandled: unknown[];
  let onUnhandled: (reason: unknown) => void;

  beforeEach(() => {
    unhandled = [];
    onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  it('does not leak an unhandled rejection when wait() is aborted while the container is still running', async () => {
    const controller = new AbortController();

    // dockerode's `.wait({ abortSignal })` rejects with an AbortError when the
    // signal fires while the request is still in flight (container running) —
    // exactly what happens when an op times out or is stopped mid-run.
    const wait = new Promise<void>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          const err: any = new Error('The operation was aborted');
          err.code = 'ABORT_ERR';
          err.cause = controller.signal.reason;
          reject(err);
        },
        { once: true },
      );
    });

    const container = {
      logs: async () => openStream(),
      stats: async () => openStream(),
      wait: () => wait,
      inspect: async () => ({ State: { Status: 'running' } }),
    } as unknown as Dockerode.Container;

    const manager = new ContainerStateManager(
      container,
      controller,
      new EventEmitter(),
      undefined, // no restart policy -> uses the `.wait()` branch
    );

    await manager.startMonitoring();

    // A timeout / stop aborts the op while the container is still running.
    controller.abort('expired');

    await flush();

    expect(unhandled).toEqual([]);
    expect(manager.getState()).toBe('exited');

    manager.stopMonitoring();
  });

  it('emits every frame when a single data chunk carries multiple multiplexed frames', async () => {
    const controller = new AbortController();
    const logStream = new Readable({ read() {} });

    const container = {
      logs: async () => logStream,
      stats: async () => openStream(),
      wait: () => new Promise<void>(() => {}), // stays running
      inspect: async () => ({ State: { Status: 'running' } }),
    } as unknown as Dockerode.Container;

    const emitter = new EventEmitter();
    const received: Array<{ log: string; type: string }> = [];
    emitter.on('log', (log, type) => received.push({ log, type }));

    const manager = new ContainerStateManager(
      container,
      controller,
      emitter,
      undefined,
    );

    await manager.startMonitoring();

    // At container exit Docker flushes the trailing stderr line and the final
    // stdout result line together, coalesced into a single chunk.
    const chunk = Buffer.concat([
      frame('stderr', '2026-06-08T00:51:01Z \n'),
      frame('stdout', '2026-06-08T00:51:01Z {"devices":[]}\n'),
    ]);
    logStream.push(chunk);

    await flush();

    expect(received).toEqual([
      { log: '\n', type: 'stderr' },
      { log: '{"devices":[]}\n', type: 'stdout' },
    ]);

    manager.stopMonitoring();
  });

  it('emits a frame that is split across two data chunks', async () => {
    const controller = new AbortController();
    const logStream = new Readable({ read() {} });

    const container = {
      logs: async () => logStream,
      stats: async () => openStream(),
      wait: () => new Promise<void>(() => {}), // stays running
      inspect: async () => ({ State: { Status: 'running' } }),
    } as unknown as Dockerode.Container;

    const emitter = new EventEmitter();
    const received: Array<{ log: string; type: string }> = [];
    emitter.on('log', (log, type) => received.push({ log, type }));

    const manager = new ContainerStateManager(
      container,
      controller,
      emitter,
      undefined,
    );

    await manager.startMonitoring();

    const full = frame('stdout', '2026-06-08T00:51:01Z {"devices":[]}\n');
    // The TCP/stream layer can split a single frame across data events.
    logStream.push(full.subarray(0, 12));
    logStream.push(full.subarray(12));

    await flush();

    expect(received).toEqual([
      { log: '{"devices":[]}\n', type: 'stdout' },
    ]);

    manager.stopMonitoring();
  });

  it('waitForLogsDrained waits for the final buffered frames before resolving after exit', async () => {
    const controller = new AbortController();
    const logStream = new Readable({ read() {} });
    let resolveWait!: () => void;
    const wait = new Promise<void>((resolve) => {
      resolveWait = resolve;
    });

    const container = {
      logs: async () => logStream,
      stats: async () => openStream(),
      wait: () => wait,
      inspect: async () => ({ State: { Status: 'exited' } }),
    } as unknown as Dockerode.Container;

    const emitter = new EventEmitter();
    const received: string[] = [];
    emitter.on('log', (log) => received.push(log));

    const manager = new ContainerStateManager(
      container,
      controller,
      emitter,
      undefined,
    );

    await manager.startMonitoring();

    // Container process exits, but the final result line is still in flight on
    // the (separate) log stream connection.
    resolveWait();
    await manager.waitForExit();

    let drained = false;
    const drainedPromise = manager
      .waitForLogsDrained(2000)
      .then(() => {
        drained = true;
      });

    await flush();
    expect(drained).toBe(false); // must not resolve while the stream is open

    logStream.push(frame('stdout', '2026-06-08T00:51:01Z {"devices":[]}\n'));
    logStream.push(null); // EOF -> 'end' -> 'close'
    await drainedPromise;

    expect(drained).toBe(true);
    expect(received).toContain('{"devices":[]}\n');

    manager.stopMonitoring();
  });

  it('marks the container exited when wait() resolves naturally', async () => {
    const controller = new AbortController();

    const container = {
      logs: async () => openStream(),
      stats: async () => openStream(),
      wait: () => Promise.resolve(),
      inspect: async () => ({ State: { Status: 'exited' } }),
    } as unknown as Dockerode.Container;

    const manager = new ContainerStateManager(
      container,
      controller,
      new EventEmitter(),
      undefined,
    );

    await manager.startMonitoring();
    await flush();

    expect(unhandled).toEqual([]);
    expect(manager.getState()).toBe('exited');

    manager.stopMonitoring();
  });
});
