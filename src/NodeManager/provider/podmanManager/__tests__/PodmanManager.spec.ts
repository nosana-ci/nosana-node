import { beforeEach, describe, expect, it, vi } from 'vitest';

const notFound = () =>
  Object.assign(new Error('not found'), { statusCode: 404 });

const podman = {
  inspect: vi.fn(),
  start: vi.fn(),
  remove: vi.fn(),
};
const self = {
  inspect: vi.fn(),
};
const created = { start: vi.fn() };
const docker = {
  getContainer: vi.fn(),
  createContainer: vi.fn(),
  createNetwork: vi.fn(),
};
const hostDocker = {
  docker,
  hasVolume: vi.fn(),
  createVolume: vi.fn(),
  hasNetwork: vi.fn(),
  pullImage: vi.fn(),
} as any;
const registry = { restartRunningOperations: vi.fn() };

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      hostname: () => 'nodeid',
      homedir: () => '/root',
    },
  };
});
vi.mock('../../../configs/configs.js', () => ({
  configs: () => ({ podman: { containerImage: 'nosana/podman:test' } }),
}));
vi.mock('../../../node/task/TaskManagerRegistry.js', () => ({
  TaskManagerRegistry: { getInstance: () => registry },
}));

const { PodmanManager, isStaleCdiEvent, podmanContainerConfig } = await import(
  '../PodmanManager.js'
);

const orchestration = { healthy: vi.fn() } as any;

function manager() {
  return new PodmanManager(hostDocker, '~/.nosana/', orchestration);
}

describe('PodmanManager', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    docker.getContainer.mockImplementation((name: string) =>
      name === 'podman' ? podman : self,
    );
    docker.createContainer.mockResolvedValue(created);
    hostDocker.hasVolume.mockResolvedValue(false);
    hostDocker.hasNetwork.mockResolvedValue(false);
    podman.inspect.mockResolvedValue({ State: { Running: true } });
    self.inspect.mockResolvedValue({
      Mounts: [{ Destination: '/root/.nosana', Source: '/home/host/.nosana' }],
    });
    orchestration.healthy.mockResolvedValue({ status: true });
  });

  it('creates the container from the node’s host config dir when it is absent', async () => {
    podman.inspect.mockRejectedValue(notFound());

    await manager().ensure();

    expect(hostDocker.createVolume).toHaveBeenCalledTimes(2);
    expect(docker.createNetwork).toHaveBeenCalledTimes(1);
    expect(hostDocker.pullImage).toHaveBeenCalledWith('nosana/podman:test');
    expect(docker.createContainer).toHaveBeenCalledWith(
      podmanContainerConfig('nosana/podman:test', '/home/host/.nosana'),
    );
    expect(created.start).toHaveBeenCalled();
    expect(registry.restartRunningOperations).not.toHaveBeenCalled();
  });

  it('refuses to create when the config dir is not a host mount', async () => {
    podman.inspect.mockRejectedValue(notFound());
    self.inspect.mockResolvedValue({ Mounts: [] });

    await expect(manager().ensure()).rejects.toThrow(/bind-mounted/);

    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it('starts a stopped container rather than recreating it', async () => {
    podman.inspect.mockResolvedValue({ State: { Running: false } });

    await manager().ensure();

    expect(podman.start).toHaveBeenCalled();
    expect(podman.remove).not.toHaveBeenCalled();
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it('leaves a healthy container alone', async () => {
    await manager().ensure();

    expect(podman.start).not.toHaveBeenCalled();
    expect(podman.remove).not.toHaveBeenCalled();
  });

  it('recreate() restarts the running operations, removes the container and keeps the volumes', async () => {
    const order: string[] = [];
    registry.restartRunningOperations.mockImplementation(() =>
      order.push('restart'),
    );
    podman.remove.mockImplementation(async () => {
      order.push('remove');
    });
    podman.inspect.mockRejectedValueOnce(notFound());
    const m = manager();
    m.markStale('{"event":"unrepairable"}');

    await m.recreate('between jobs');

    expect(order).toEqual(['restart', 'remove']);
    expect(podman.remove).toHaveBeenCalledWith({ force: true });
    expect(docker.createContainer).toHaveBeenCalledTimes(1);
    expect(hostDocker.createVolume).toHaveBeenCalledTimes(2);
    expect(m.isStale()).toBe(false);
  });

  it('prepares the volumes, network, image and host path once per process', async () => {
    podman.inspect.mockRejectedValue(notFound());
    const m = manager();

    await m.ensure();
    m.ready();
    await m.recreate('between jobs');

    expect(docker.createContainer).toHaveBeenCalledTimes(2);
    expect(self.inspect).toHaveBeenCalledTimes(1);
    expect(hostDocker.pullImage).toHaveBeenCalledTimes(1);
    expect(hostDocker.hasVolume).toHaveBeenCalledTimes(2);
  });

  it('does not recreate a container it just created that nothing has used', async () => {
    podman.inspect.mockRejectedValueOnce(notFound());
    const m = manager();
    await m.ensure();

    await m.recreate('between jobs');
    expect(podman.remove).not.toHaveBeenCalled();

    // an operation started on it since
    m.ready();
    await m.recreate('between jobs');
    expect(podman.remove).toHaveBeenCalledTimes(1);
  });

  it('recreates a fresh container all the same when it was marked stale', async () => {
    podman.inspect.mockRejectedValueOnce(notFound());
    const m = manager();
    await m.ensure();
    m.markStale('{"event":"unrepairable"}');

    await m.recreate('between jobs');

    expect(podman.remove).toHaveBeenCalledTimes(1);
  });

  it('ready() holds callers until a recreate under way is done', async () => {
    let releaseSocket!: () => void;
    orchestration.healthy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSocket = () => resolve({ status: true });
        }),
    );
    const m = manager();
    const recreate = m.recreate('test');

    let ready = false;
    const waiting = m.ready().then(() => {
      ready = true;
    });
    // the socket is being waited for: the container is gone and back
    await vi.waitFor(() => expect(orchestration.healthy).toHaveBeenCalled());
    expect(podman.remove).toHaveBeenCalled();
    expect(ready).toBe(false);

    releaseSocket();
    await recreate;
    await waiting;
    expect(ready).toBe(true);
    await expect(m.ready()).resolves.toBeUndefined();
  });

  it('joins a recreate already under way instead of repeating it', async () => {
    const m = manager();

    await Promise.all([m.recreate('one'), m.recreate('two')]);

    expect(podman.remove).toHaveBeenCalledTimes(1);
  });

  it('fails when the socket never answers', async () => {
    vi.useFakeTimers();
    orchestration.healthy.mockResolvedValue({ status: false });

    const result = manager().ensure();
    const expectation = expect(result).rejects.toThrow(/did not answer/);
    await vi.runAllTimersAsync();
    await expectation;

    vi.useRealTimers();
  });
});

describe('isStaleCdiEvent', () => {
  it('matches the watcher events that call for a recreate', () => {
    expect(isStaleCdiEvent('{"event":"unrepairable","path":"/x"}')).toBe(true);
    expect(isStaleCdiEvent('{"event":"repair-failed","path":"/x"}')).toBe(true);
  });

  it('ignores repaired events and noise', () => {
    expect(isStaleCdiEvent('{"event":"repaired","path":"/x"}')).toBe(false);
    expect(isStaleCdiEvent('not json')).toBe(false);
  });
});
