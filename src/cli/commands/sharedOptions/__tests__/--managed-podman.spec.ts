import { afterEach, describe, expect, it } from 'vitest';

import {
  MANAGED_PODMAN_SOCKET,
  resolveProvider,
} from '../--managed-podman.js';

describe('resolveProvider', () => {
  const argv = process.argv;
  afterEach(() => {
    process.argv = argv;
  });

  it('selects docker when --docker is given', () => {
    process.argv = ['node', 'start', '--docker', '/var/run/docker.sock'];
    const options = { podman: '/var/run/docker.sock' };
    resolveProvider(options);
    expect(options).toEqual({
      podman: '/var/run/docker.sock',
      provider: 'docker',
    });
  });

  it('selects podman otherwise', () => {
    process.argv = ['node', 'start'];
    const options = { podman: '~/.nosana/podman/podman.sock' };
    resolveProvider(options);
    expect(options.provider).toBe('podman');
  });

  it('with --managed-podman, the --docker URI is the docker socket and jobs run over the managed podman socket', () => {
    process.argv = ['node', 'start', '--docker', '/var/run/docker.sock', '--managed-podman'];
    const options = { podman: '/var/run/docker.sock', managedPodman: true };
    resolveProvider(options);
    expect(options).toEqual({
      managedPodman: true,
      provider: 'podman',
      dockerSocket: '/var/run/docker.sock',
      podman: MANAGED_PODMAN_SOCKET,
    });
  });
});
