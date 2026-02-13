import { DockerContainerOrchestration } from './docker/index.js';
import { PodmanContainerOrchestration } from './podman/index.js';

import type { ContainerOrchestrationInterface } from './interface.js';

export function selectContainerOrchestrationProvider(
  provider: string,
  url: string,
  gpu: string,
  teeRuntime: string | undefined,
): ContainerOrchestrationInterface {
  if (provider !== 'docker' && teeRuntime) {
    throw new Error('Custom runtimes are only supported with the Docker provider.');
  }

  switch (provider) {
    case 'podman':
      return new PodmanContainerOrchestration(url, gpu, undefined);
    case 'docker':
    default:
      return new DockerContainerOrchestration(url, gpu, teeRuntime);
  }
}
