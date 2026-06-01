import os from 'os';
import {
  Container,
  ContainerCreateOptions,
  ImageInfo,
  Image,
  MountSettings,
  Volume,
  VolumeCreateResponse,
  VolumeInspectInfo,
  ContainerInspectInfo,
} from 'dockerode';
import { DockerAuth } from '@nosana/sdk';

import { DockerExtended } from './dockerExtended/index.js';
import { createSeverObject } from './utils/createServerObject.js';
import {
  ContainerOrchestrationInterface,
  RunContainerArgs,
} from '../interface.js';

import { ReturnedStatus } from '../../types.js';
import { checkDeprecationDeadline } from './utils/deadline.js';
import { createDockerRunOptions } from './createDockerRunOptions.js';
import { liveAbortSignal } from '../../../utils/liveAbortSignal.js';

export class DockerContainerOrchestration
  implements ContainerOrchestrationInterface {
  public docker: DockerExtended;
  public host: string;
  public port: string;
  public protocol: 'https' | 'http' | 'ssh' | 'socket';
  public name: string = 'docker';
  public gpu: string = 'all';
  public teeRuntime?: string;
  public listeners = new Map<string, Array<() => Promise<void>>>();

  constructor(server: string, gpu: string, teeRuntime?: string) {
    this.gpu = gpu;
    this.teeRuntime = teeRuntime;
    if (server.startsWith('http') || server.startsWith('ssh')) {
      const { host, port, protocol } = createSeverObject(server);

      this.host = host;
      this.port = port;
      this.protocol = protocol;
      this.docker = new DockerExtended({
        host: this.host,
        port: this.port,
        protocol: this.protocol,
      });
    } else {
      // Assume server is a socket path
      this.protocol = 'socket';
      if (server.startsWith('~')) {
        server = server.replace('~', os.homedir());
      }
      this.host = server;
      this.port = '';
      this.docker = new DockerExtended({ socketPath: this.host });
    }
  }

  async checkCustomRuntimeAvailability(runtime: string): Promise<boolean> {
    // TODO: implement a better check for custom runtimes by creating and starting a basic container with the runtime
    try {
      const info = await this.docker.info();
      if (info.Runtimes && info.Runtimes[runtime]) {
        return true;
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  async getContainerByName(name: string): Promise<Container | undefined> {
    const containers = await this.docker
      .listContainers({ all: true })
      .catch((_) => {
        throw new Error('could not get containers');
      });

    const matchedContainer = containers.find((container) =>
      container.Names.includes(`/${name}`),
    );

    if (!matchedContainer) return undefined;

    return this.docker.getContainer(matchedContainer.Id);
  }

  async getContainersByName(names: string[]): Promise<Container[]> {
    try {
      const containers = await this.docker.listContainers({ all: true });

      const matchedContainers = containers.filter((container) =>
        names.some((name) => container.Names.includes(`/${name}`)),
      );

      if (matchedContainers.length > 0) {
        const containerObjects = matchedContainers.map((containerInfo) =>
          this.docker.getContainer(containerInfo.Id),
        );

        return containerObjects;
      } else {
        return [];
      }
    } catch (_) {
      throw new Error('could not get containers');
    }
  }

  getConnection() {
    return this.docker;
  }

  async pullImage(
    image: string,
    authorisation?: DockerAuth,
    controller?: AbortController,
  ): Promise<void> {
    try {
      if (controller?.signal.aborted) throw controller.signal.reason;
      if (await this.docker.hasImage(image)) return;

      await this.docker.promisePull(
        image,
        controller ?? new AbortController(),
        authorisation,
      );
    } catch (error) {
      if (error instanceof Error) {
        error.eventType = 'image-pull-error';
      }
      throw error;
    }
  }

  async hasImage(image: string): Promise<boolean> {
    return await this.docker.hasImage(image);
  }

  async getImage(image: string): Promise<Image> {
    return this.docker.getImage(image);
  }

  async listImages(): Promise<ImageInfo[]> {
    return this.docker.listImages();
  }

  async deleteImage(
    image: string,
    controller?: AbortController,
  ): Promise<void> {
    if (await this.docker.hasImage(image)) {
      await this.docker
        .getImage(image)
        .remove({ force: true, abortSignal: liveAbortSignal(controller?.signal) });
    }
  }

  async createNetwork(
    _name: string,
    controller?: AbortController,
  ): Promise<void> {
    try {
      if (await this.hasNetwork('NOSANA_GATEWAY')) return;
      await this.docker.createNetwork({
        Name: 'NOSANA_GATEWAY',
        Driver: 'bridge',
        IPAM: {
          Driver: 'default',
          Config: [{ Subnet: '192.168.101.0/24', Gateway: '192.168.101.1' }],
        },
        abortSignal: liveAbortSignal(controller?.signal),
      });
    } catch (error) {
      if (error instanceof Error) {
        error.eventType = 'resource-error';
      }
      throw error;
    }
  }

  async hasNetwork(name: string): Promise<boolean> {
    const networks = await this.docker.listNetworks();
    return networks.some((network) => network.Name === name);
  }

  async deleteNetwork(
    name: string,
    controller?: AbortController,
  ): Promise<void> {
    // await this.docker.getNetwork(name).remove({ abortSignal: controller?.signal });
  }

  async createVolume(
    name?: string,
    controller?: AbortController,
  ): Promise<VolumeCreateResponse> {
    try {
      return await this.docker.createVolume({ Name: name });
    } catch (error) {
      if (error instanceof Error) {
        error.eventType = 'resource-error';
      }
      throw error;
    }
  }

  async hasVolume(name: string): Promise<boolean> {
    try {
      const volumes = await this.docker.listVolumes();
      return volumes.Volumes.some((volume) => volume.Name === name);
    } catch (error) {
      return false;
    }
  }

  async listVolumes(): Promise<VolumeInspectInfo[]> {
    return (await this.docker.listVolumes()).Volumes;
  }

  async getVolume(name: string): Promise<Volume> {
    return this.docker.getVolume(name);
  }

  async getRawVolume(name: string): Promise<Volume> {
    return this.docker.getVolume(name);
  }

  async deleteVolume(
    name: string,
    controller?: AbortController,
  ): Promise<void> {
    const volume = this.docker.getVolume(name);

    try {
      await volume.inspect(); // This will throw if the volume doesn't exist
      await volume.remove({ force: true, abortSignal: liveAbortSignal(controller?.signal) });
    } catch (error: any) {
      if (error.statusCode === 404) {
        // Volume doesn't exist, nothing to delete
        return;
      }
      throw error;
    }
  }

  async healthy(): Promise<ReturnedStatus> {
    if (this.protocol != 'socket') {
      checkDeprecationDeadline();
    }

    try {
      const info = await this.docker.info();
      if (typeof info === 'object' && info !== null && info.ID) {
        return { status: true };
      }
      return { status: false, error: new Error('invalid docker info') };
    } catch (error) {
      return { status: false, error };
    }
  }

  async getContainer(id: string): Promise<Container> {
    const container = this.docker.getContainer(id);
    return container;
  }

  getProtocol(): string {
    return this.protocol;
  }

  setupContainerAbortListener(
    containerId: string,
    controller: AbortController,
  ) {
    if (controller.signal.aborted) {
      this.stopContainer(containerId);
    }

    const stopFunction = async () => {
      await this.stopContainer(containerId);
    };

    controller.signal.addEventListener('abort', stopFunction);
    const current = this.listeners.get(containerId) || [];
    current.push(stopFunction);
    this.listeners.set(containerId, current);
  }

  async runContainer(
    args: ContainerCreateOptions,
    controller?: AbortController,
  ): Promise<Container> {
    try {
      if (controller?.signal.aborted) {
        throw controller.signal.reason;
      }

      const container = await this.docker.createContainer({
        ...args,
        abortSignal: liveAbortSignal(controller?.signal),
      });
      await container.start();
      if (controller) {
        this.setupContainerAbortListener(container.id, controller);
      }
      return container;
    } catch (error) {
      if (error instanceof Error) {
        error.eventType = 'container-runtime-error';
      }
      throw error;
    }
  }

  async runFlowContainer(
    image: string,
    args: RunContainerArgs,
  ): Promise<Container> {
    try {
      const container = await this.docker.createContainer({
        ...createDockerRunOptions(image, args, this.gpu),
      });

      await container.start();

      return container;
    } catch (error) {
      if (error instanceof Error) {
        error.eventType = 'container-runtime-error';
      }
      throw error;
    }
  }

  async stopContainer(id: string, controller?: AbortController): Promise<void> {
    const listeners = this.listeners.get(id) || [];
    if (controller) {
      for (const l of listeners)
        controller.signal.removeEventListener('abort', l);
    }
    const container = this.docker.getContainer(id);
    try {
      const info = await container.inspect();
      if (info.State.Status !== 'exited')
        await container.stop({ abortSignal: liveAbortSignal(controller?.signal) });
    } catch { }
  }

  async stopAndDeleteContainer(
    id: string,
    controller?: AbortController,
  ): Promise<ContainerInspectInfo | undefined> {
    const listeners = this.listeners.get(id) || [];
    if (controller) {
      for (const l of listeners)
        controller.signal.removeEventListener('abort', l);
    }
    const container = await this.docker.getContainer(id);
    try {
      // Need to catch in case container is already stopped
      await container.stop({ abortSignal: liveAbortSignal(controller?.signal) }).catch(() => { });
      const info = await container.inspect();
      await container.remove({
        force: true,
        v: true,
        abortSignal: liveAbortSignal(controller?.signal),
      });
      return info;
    } catch (error) {
      return undefined;
    }
  }

  async isContainerExited(id: string): Promise<boolean> {
    try {
      const info = await this.docker.getContainer(id).inspect();
      return info.State.Status === 'exited';
    } catch {
      return true;
    }
  }

  async doesContainerExist(id: string): Promise<boolean> {
    try {
      await this.docker.getContainer(id).inspect();
      return true;
    } catch (e: any) {
      if (e.statusCode === 404) return false;
      throw e;
    }
  }

  async check(): Promise<string> {
    const { status, error } = await this.healthy();
    if (!status) {
      throw new Error(
        `error on container orchestration (docker or podman), error: ${error}`,
      );
    }
    return `${this.protocol}://${this.host}:${this.port}`;
  }
}


