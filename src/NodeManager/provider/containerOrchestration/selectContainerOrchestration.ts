import { DockerContainerOrchestration } from './docker/index.js';
import { PodmanContainerOrchestration } from './podman/index.js';

import type { ContainerOrchestrationInterface } from './interface.js';

export function selectContainerOrchestrationProvider(
  provider: string,
  url: string,
  gpu: string,
): ContainerOrchestrationInterface {
  switch (provider) {
    case 'podman':
      return new PodmanContainerOrchestration(url, gpu);
    case 'docker':
    default:
      return new DockerContainerOrchestration(url, gpu);
  }
}
