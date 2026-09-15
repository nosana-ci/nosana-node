import os from 'os';
import chalk from 'chalk';
import type Dockerode from 'dockerode';
import type { ContainerCreateOptions } from 'dockerode';

import { configs } from '../../configs/configs.js';
import { sleep } from '../../utils/utils.js';
import { TaskManagerRegistry } from '../../node/task/TaskManagerRegistry.js';
import type { DockerContainerOrchestration } from '../containerOrchestration/docker/index.js';
import type { ContainerOrchestrationInterface } from '../containerOrchestration/interface.js';

const PODMAN_CONTAINER_NAME = 'podman';
/**
 * The docker network the node, the podman container and the node's API proxy
 * share. It carries the name the docker provider hard-codes into every
 * container it starts (see createDockerRunOptions), which is how the API
 * proxy lands on it and reaches the node by container name. It is not the
 * NOSANA_GATEWAY podman creates inside itself for the jobs, hence the
 * different subnet.
 */
const HOST_NETWORK = 'NOSANA_GATEWAY';
const CACHE_VOLUME = 'podman-cache';
const SOCKET_VOLUME = 'podman-socket';
const SOCKET_WAIT_S = 60;
const SOCKET_POLL_S = 2;

/**
 * Events the podman container's CDI watcher writes when a GPU path it needs
 * is gone and cannot be repaired from in there: only recreating the container
 * re-injects the host's current driver.
 */
const STALE_CDI_EVENTS = ['unrepairable', 'repair-failed'];

/** A CDI event line, as the podman container logs them, that asks for a recreate. */
export function isStaleCdiEvent(line: string): boolean {
  try {
    return STALE_CDI_EVENTS.includes(JSON.parse(line).event);
  } catch {
    return false;
  }
}

/**
 * Owns the podman container the node uses as its provider, over the host's
 * docker socket. The node runs beside podman rather than inside it, so it can
 * recreate podman without taking itself down.
 *
 * The container is a snapshot of the host's NVIDIA driver, taken when it is
 * created; once the host replaces the driver underneath it, GPU containers
 * inside it can no longer start. Recreating the container is the fix, and it
 * is cheap: the image cache and the resource volumes live on docker volumes
 * that survive it. What does not survive is whatever was running inside, so a
 * recreate restarts the running operations around itself, and operation
 * starts wait on `ready()` while it is under way.
 */
export class PodmanManager {
  private docker: Dockerode;
  private configDir: string;
  private staleReason?: string;
  private recreating?: Promise<void>;
  /** What a create needs and nothing changes afterwards, settled once. */
  private prepared?: Promise<string>;
  /**
   * Created by this process and not used by any operation since: it already
   * carries the host's current driver, so a recreate would change nothing.
   */
  private fresh = false;

  constructor(
    /** The host's docker, which also runs the node's API proxy. */
    public readonly hostDocker: DockerContainerOrchestration,
    configDir: string,
    private podman: ContainerOrchestrationInterface,
  ) {
    this.docker = hostDocker.docker;
    this.configDir = configDir.replace(/^~/, os.homedir()).replace(/\/+$/, '');
  }

  /**
   * Note a fault the podman container's watcher reported. Acted on by the
   * next recreate, and while the node is queued it leaves the queue for one.
   */
  markStale(reason: string): void {
    if (this.staleReason) return;
    this.staleReason = reason;
    console.warn(
      chalk.yellow(
        `The podman container's GPU mounts are stale (${reason}); it is recreated before the next job.`,
      ),
    );
  }

  isStale(): boolean {
    return this.staleReason !== undefined;
  }

  /** Resolves once no recreate is in flight: operation starts wait on this. */
  ready(): Promise<void> {
    this.fresh = false;
    return this.recreating ?? Promise.resolve();
  }

  /** The podman container exists, runs, and answers on its socket. */
  async ensure(): Promise<void> {
    await this.ensureRunning();
    await this.waitForSocket();
  }

  /**
   * Remove the podman container and bring up a fresh one; the volumes stay.
   * Operations running inside are restarted around it: aborted now, while
   * their containers can still be stopped, and relaunched once the new
   * socket answers, which `ready()` holds them for. A recreate already under
   * way is joined rather than repeated, and a container this process created
   * that nothing has used since is left as it is, unless it was marked stale.
   */
  recreate(reason: string): Promise<void> {
    if (this.recreating) return this.recreating;
    if (this.fresh && !this.staleReason) return Promise.resolve();

    this.recreating = this.doRecreate(reason).finally(() => {
      this.recreating = undefined;
    });
    return this.recreating;
  }

  private async doRecreate(reason: string): Promise<void> {
    console.log(chalk.yellow(`Recreating the podman container: ${reason}`));
    this.staleReason = undefined;

    TaskManagerRegistry.getInstance().restartRunningOperations();

    try {
      await this.docker
        .getContainer(PODMAN_CONTAINER_NAME)
        .remove({ force: true });
    } catch (error: any) {
      if (error.statusCode !== 404) throw error;
    }

    await this.ensureRunning();
    await this.waitForSocket();
  }

  private async ensureRunning(): Promise<void> {
    const container = this.docker.getContainer(PODMAN_CONTAINER_NAME);
    let info: Dockerode.ContainerInspectInfo;
    try {
      info = await container.inspect();
    } catch (error: any) {
      if (error.statusCode !== 404) throw error;
      return this.create();
    }

    if (!info.State.Running) await container.start();
  }

  private async create(): Promise<void> {
    const image = configs().podman.containerImage;
    this.prepared ??= this.prepare(image).catch((error) => {
      this.prepared = undefined; // so the next create tries again
      throw error;
    });
    const hostConfigDir = await this.prepared;

    console.log(chalk.cyan(`Creating the podman container from ${image}`));
    const container = await this.docker.createContainer(
      podmanContainerConfig(image, hostConfigDir),
    );
    await container.start();
    this.fresh = true;
  }

  /** @returns the host path of the node's config dir, for the bind mount. */
  private async prepare(image: string): Promise<string> {
    const [hostConfigDir] = await Promise.all([
      this.hostConfigDir(),
      this.ensureVolume(CACHE_VOLUME),
      this.ensureVolume(SOCKET_VOLUME),
      this.ensureNetwork(),
      this.hostDocker.pullImage(image),
    ]);
    return hostConfigDir;
  }

  private async waitForSocket(): Promise<void> {
    const deadline = Date.now() + SOCKET_WAIT_S * 1000;
    while (Date.now() < deadline) {
      if ((await this.podman.healthy()).status) return;
      await sleep(SOCKET_POLL_S);
    }
    throw new Error(
      `The podman container is running but its socket did not answer within ${SOCKET_WAIT_S}s`,
    );
  }

  private async ensureVolume(name: string): Promise<void> {
    if (!(await this.hostDocker.hasVolume(name))) {
      await this.hostDocker.createVolume(name);
    }
  }

  private async ensureNetwork(): Promise<void> {
    if (await this.hostDocker.hasNetwork(HOST_NETWORK)) return;
    await this.docker.createNetwork({
      Name: HOST_NETWORK,
      Driver: 'bridge',
      IPAM: {
        Driver: 'default',
        Config: [{ Subnet: '192.168.102.0/24', Gateway: '192.168.102.1' }],
      },
    });
  }

  /**
   * Where the node's config dir lives on the host, read off this container's
   * own mounts: podman needs it at the host path, and the node only knows its
   * own.
   */
  private async hostConfigDir(): Promise<string> {
    let mounts: Dockerode.ContainerInspectInfo['Mounts'] = [];
    try {
      ({ Mounts: mounts } = await this.docker
        .getContainer(os.hostname())
        .inspect());
    } catch {
      // Reported below, with what is needed rather than what failed.
    }

    const mount = mounts.find(
      (m) => m.Destination.replace(/\/+$/, '') === this.configDir,
    );
    if (!mount?.Source) {
      throw new Error(
        `Cannot manage podman: the node's config dir ${this.configDir} must be bind-mounted from the host, and the node must run in a docker container whose hostname is its id.`,
      );
    }
    return mount.Source;
  }
}

/** Mirrors the podman container the hosted start script creates. */
export function podmanContainerConfig(
  image: string,
  hostConfigDir: string,
): ContainerCreateOptions {
  return {
    name: PODMAN_CONTAINER_NAME,
    Image: image,
    Cmd: ['unix:/podman/podman.sock'],
    Env: ['ENABLE_GPU=true', 'NVIDIA_DRIVER_CAPABILITIES=all'],
    NetworkingConfig: { EndpointsConfig: { [HOST_NETWORK]: {} } },
    HostConfig: {
      Privileged: true,
      DeviceRequests: [
        { Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] },
      ],
      Devices: [
        {
          PathOnHost: '/dev/fuse',
          PathInContainer: '/dev/fuse',
          CgroupPermissions: 'rwm',
        },
      ],
      Mounts: [
        { Type: 'volume', Source: CACHE_VOLUME, Target: '/var/lib/containers' },
        { Type: 'volume', Source: SOCKET_VOLUME, Target: '/podman' },
        { Type: 'bind', Source: hostConfigDir, Target: '/root/.nosana' },
        {
          Type: 'bind',
          Source: '/run/nvidia-persistenced',
          Target: '/run/nvidia-persistenced',
          BindOptions: { Propagation: 'rslave' },
        },
      ],
      RestartPolicy: { Name: 'unless-stopped' },
    },
  };
}
