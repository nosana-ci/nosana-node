import { Container } from 'dockerode';
import { ReturnedStatus } from '../../types.js';
import { DockerContainerOrchestration } from '../docker/index.js';
import { RunContainerArgs } from '../interface.js';
import { createPodmanRunOptions } from './utils/createPodmanRunOptions.js';
import { fetch, Agent, RequestInit, Response } from 'undici';

export class PodmanContainerOrchestration extends DockerContainerOrchestration {
  private api: string;
  public name: string = 'podman';

  constructor(server: string, gpu: string, _teeRuntime?: string) {
    super(server, gpu);
    if (this.protocol === 'socket') {
      this.api = `http://localhost/v4.5.0/libpod`;
    } else {
      this.api = `${this.protocol}://${this.host}:${this.port}/v4.5.0/libpod`;
    }
  }

  async libPodAPICall(path: string, options: RequestInit): Promise<Response> {
    if (this.protocol === 'socket') {
      options.dispatcher = new Agent({
        connect: {
          socketPath: this.host,
        },
      });
    }

    return fetch(`${this.api}${path}`, options);
  }

  async createNetwork(
    _name: string,
    controller?: AbortController,
  ): Promise<void> {
    try {
      if (await this.hasNetwork('NOSANA_GATEWAY')) return;
      await this.docker.createNetwork({
        Name: 'NOSANA_GATEWAY',
        IPAM: {
          Driver: 'bridge',
          Config: [{ Subnet: '192.168.101.0/24', Gateway: '192.168.101.1' }],
        },
        abortSignal: controller?.signal,
      });
    } catch (error) {
      if (error instanceof Error) {
        error.eventType = 'resource-error';
      }
      throw error;
    }
  }

  async runFlowContainer(
    image: string,
    args: RunContainerArgs,
  ): Promise<Container> {
    try {
      let error: any;
      // Incase of error, retry 3 times
      for (let i = 0; i < 3; i++) {
        // Sleep between retries to try and let podman image copying finalise
        await new Promise((res) => setTimeout(res, 3000 * i));
        const create = await this.libPodAPICall(`/containers/create`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(createPodmanRunOptions(image, args, this.gpu)),
        });

        if (create.status === 201) {
          const createResult: any = await create.json();
          const start = await this.libPodAPICall(
            `/containers/${createResult.Id}/start`,
            {
              method: 'POST',
            },
          );
          if (start.status === 204) {
            const container = this.docker.getContainer(createResult.Id);
            return container;
          } else {
            throw new Error(
              'Cannot start container: ' +
              ((await start.json()) as any).message,
            );
          }
        }

        error = await create.json();
        if (error.message !== `${image}: image not known`) break;
      }

      throw error;
    } catch (error) {
      if (error instanceof Error) {
        error.eventType = 'container-runtime-error';
      }
      throw error;
    }
  }
}
