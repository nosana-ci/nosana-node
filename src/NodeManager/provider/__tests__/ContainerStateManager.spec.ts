import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';
import { EventEmitter } from 'events';
import type Dockerode from 'dockerode';

import { ContainerStateManager } from '../ContainerStateManager.js';

/** A readable that stays open and produces nothing until destroyed. */
function openStream(): Readable {
  return new Readable({ read() {} });
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
