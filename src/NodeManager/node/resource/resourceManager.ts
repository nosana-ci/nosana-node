import { Market, RequiredResource } from '@nosana/sdk';
import { HFResource, Resource } from '@nosana/sdk/dist/types/resources.js';

import { HostManager } from '../market/hostManager.js';
import { ContainerOrchestrationInterface } from '../../provider/containerOrchestration/interface.js';
import { NodeRepository } from '../../repository/NodeRepository.js';
import { createResourceName } from './helpers/createResourceName.js';
import { ImageManager } from './image/imageManager.js';
import { JobContext, VolumeManager } from './volume/volumeManager.js';

/**
 * The market endpoint reports an HF resource's model as `url`, the field it
 * also uses for S3, while everywhere else in the node — job definitions
 * included — an HF resource names it `repo`. Translate on the way in, so only
 * one shape reaches the download path.
 *
 * Resources that already carry `repo` are left alone: this is the market
 * boundary, but the same manager serves job resources.
 */
export function normalizeMarketResources(
  resources: RequiredResource[],
): RequiredResource[] {
  return resources.map((resource) => {
    if (resource.type !== 'HF') return resource;

    const hf = resource as HFResource & { url?: string };
    if (hf.repo || !hf.url) return resource;

    return { ...hf, repo: hf.url };
  });
}

export class ResourceManager {
  private required_market: string | undefined;

  public images: ImageManager;
  public volumes: VolumeManager;

  constructor(
    private containerOrchestration: ContainerOrchestrationInterface,
    private repository: NodeRepository,
  ) {
    this.images = new ImageManager(containerOrchestration, repository);
    this.volumes = new VolumeManager(containerOrchestration, repository);
  }

  public async resyncResourcesDB(): Promise<void> {
    await this.images.resyncImagesDB();
    await this.volumes.resyncResourcesDB();

    if (this.required_market) {
      await this.fetchMarketRequiredResources(this.required_market);
    }
  }

  public async fetchMarketRequiredResources(market: Market | string): Promise<void> {
    this.required_market = typeof market === 'string' ? market : market.address.toString();

    try {
      const data = await HostManager.getMarketRequiredResources(this.required_market);

      if (!data) {
        return;
      }

      await this.images.pullMarketRequiredImages(data.required_images);
      await this.volumes.pullMarketRequiredVolumes(
        normalizeMarketResources(data.required_remote_resources),
      );
    } catch (error) {
      throw error;
    }
  }

  public async prune(): Promise<void> {
    await this.images.pruneImages();
    await this.volumes.pruneVolumes();
  }

  public async getResourceVolumes(
    resources: Resource[],
    controller: AbortController,
    job?: JobContext,
  ): Promise<
    {
      dest: string;
      name: string;
      readonly?: boolean;
    }[]
  > {
    const volumes: { dest: string; name: string; readonly?: boolean }[] = [];

    for (const resource of resources) {
      await this.volumes.createRemoteVolume(resource, controller, job);
      if ((await this.volumes.hasVolume(resource)) === false) {
        const error = new Error(
          `Missing required resource ${createResourceName(resource)}.`,
        );
        throw error;
      }

      volumes.push({
        dest:
          resource.type === 'Ollama'
            ? resource.target === undefined
              ? '/root/.ollama/models'
              : resource.target
            : resource.target,
        name: await this.volumes.getVolume(resource)!,
        readonly: resource.type === 'S3' && resource.allowWrite ? false : true,
      });
    }
    return volumes;
  }
}
