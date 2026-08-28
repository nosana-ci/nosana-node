import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'stream';
import { EventEmitter } from 'events';
import type Dockerode from 'dockerode';
import type { ExposedPort } from '@nosana/sdk';

import {
  ExposedPortHealthCheck,
  RestartableHealthCheck,
} from '../ExposedPortHealthCheck.js';

/**
 * The checker shells `curl` into the frpc container and reads the HTTP status
 * off stdout. This stands in for that container, replaying whatever the service
 * is meant to be answering at the moment the check runs.
 */
function frpcAnswering(status: () => string): Dockerode.Container {
  return {
    exec: async () => ({
      start: async () => {
        const stream = new Readable({ read() {} });
        const body = status();
        process.nextTick(() => {
          stream.push(body);
          stream.push(null);
        });
        return stream;
      },
    }),
  } as unknown as Dockerode.Container;
}

const waitFor = async (predicate: () => boolean, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const httpCheck = (extra: Partial<RestartableHealthCheck> = {}) =>
  ({
    type: 'http',
    path: '/health',
    method: 'GET',
    expected_status: 200,
    continuous: true,
    ...extra,
  }) as RestartableHealthCheck;

const portMap = (...checks: RestartableHealthCheck[]) =>
  new Map<string, ExposedPort>([
    [
      'expose-id',
      { port: 80, type: 'api', health_checks: checks } as ExposedPort,
    ],
  ]);

/** Wires a checker up to a service whose answer the test controls. */
function harness(
  check: RestartableHealthCheck | RestartableHealthCheck[],
  restart?: () => Promise<boolean>,
) {
  const state = { status: '200' };
  const emitter = new EventEmitter();
  const startups: Array<{ id: string }> = [];
  const failures: Array<{ id: string }> = [];
  const logs: string[] = [];

  emitter.on('healthcheck:startup:success', (payload) => startups.push(payload));
  emitter.on('healthcheck:continuous:failure', (payload) =>
    failures.push(payload),
  );
  emitter.on('log', (message) => logs.push(String(message)));

  const checker = new ExposedPortHealthCheck(
    'flow-1',
    frpcAnswering(() => state.status),
    emitter,
    'app-container',
    restart,
    5,
    5,
  );
  checker.addExposedPortsMap(portMap(...[check].flat()));

  return { state, checker, startups, failures, logs };
}

describe('ExposedPortHealthCheck', () => {
  it('restarts the container when a check fails after the service was healthy', async () => {
    const restart = vi.fn(async () => {
      // A restart that works: the service answers again on the way back up.
      state.status = '200';
      return true;
    });

    const { state, checker, startups, failures } = harness(
      httpCheck({ restart_on_failure: true }),
      restart,
    );

    checker.startServiceExposedUrlHealthCheck();
    await waitFor(() => startups.length === 1);

    // The service stops answering after having been online.
    state.status = '500';

    await waitFor(() => restart.mock.calls.length === 1);
    expect(failures).toHaveLength(1);

    // The port goes back to startup probing, so it reports itself online again
    // once the restarted service answers.
    await waitFor(() => startups.length === 2);

    checker.stopAllHealthChecks();
  });

  it('reports a failure without restarting when the check does not opt in', async () => {
    const restart = vi.fn(async () => true);

    const { state, checker, startups, failures } = harness(
      httpCheck(),
      restart,
    );

    checker.startServiceExposedUrlHealthCheck();
    await waitFor(() => startups.length === 1);

    state.status = '500';

    // The first failure after startup is reported, and that is the whole
    // effect: the container is left alone.
    await waitFor(() => failures.length === 1);
    expect(restart).not.toHaveBeenCalled();

    checker.stopAllHealthChecks();
  });

  it('stops restarting once max_restarts is reached', async () => {
    const restart = vi.fn(async () => {
      state.status = '200';
      return true;
    });

    const { state, checker, startups, logs } = harness(
      httpCheck({ restart_on_failure: true, max_restarts: 2 }),
      restart,
    );

    checker.startServiceExposedUrlHealthCheck();

    // A service that keeps coming back and falling over again.
    for (let attempt = 1; attempt <= 2; attempt++) {
      await waitFor(() => startups.length === attempt);
      state.status = '500';
      await waitFor(() => restart.mock.calls.length === attempt);
    }

    await waitFor(() => startups.length === 3);
    state.status = '500';

    await waitFor(() => logs.some((log) => log.includes('restart limit (2)')));
    expect(restart).toHaveBeenCalledTimes(2);

    checker.stopAllHealthChecks();
  });

  it('says so when a liveness check sits where it can never run', async () => {
    const { checker, logs } = harness([
      // A heavy startup-only probe in front of the liveness one: the continuous
      // pass stops at the first check that is not continuous.
      httpCheck({ continuous: false }),
      httpCheck({ restart_on_failure: true }),
    ]);

    expect(
      logs.some((log) => log.includes('is never reached')),
    ).toBe(true);

    checker.stopAllHealthChecks();
  });

  it('does not re-arm its probes when the op is torn down mid-restart', async () => {
    let releaseRestart!: (restarted: boolean) => void;
    const restart = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          releaseRestart = resolve;
        }),
    );

    const { state, checker, startups } = harness(
      httpCheck({ restart_on_failure: true }),
      restart,
    );

    checker.startServiceExposedUrlHealthCheck();
    await waitFor(() => startups.length === 1);

    state.status = '500';
    await waitFor(() => restart.mock.calls.length === 1);

    // The op ends (timeout, stop, expiry) while the restart is still in flight.
    checker.stopAllHealthChecks();
    state.status = '200';
    releaseRestart(true);

    // Nothing starts probing a container that is going away.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(startups).toHaveLength(1);
  });
});
