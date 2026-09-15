import { Option } from 'commander';

/**
 * Where the managed podman answers, inside the node: the podman-socket volume
 * is mounted there, and at /podman in the podman container.
 */
export const MANAGED_PODMAN_SOCKET = '~/.nosana/podman/podman.sock';

export const managedPodmanOption = new Option(
  '--managed-podman',
  'Run jobs in a podman container the node creates over the docker socket given with --docker, and recreates when its GPU mounts go stale',
);

/**
 * Settles which provider the --docker/--podman URI names. With
 * --managed-podman the URI is the host's docker socket, over which the node
 * creates its podman container; that podman answers on the volume the two
 * share, at the default podman socket path, and runs every job.
 */
export function resolveProvider(options: { [key: string]: any }): void {
  if (options.managedPodman) {
    options.provider = 'podman';
    options.dockerSocket = options.podman;
    options.podman = MANAGED_PODMAN_SOCKET;
  } else {
    options.provider = process.argv.some((arg) => arg === '--docker')
      ? 'docker'
      : 'podman';
  }
}
