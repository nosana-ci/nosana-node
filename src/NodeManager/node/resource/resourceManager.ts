import { Market, RequiredResource } from '@nosana/sdk';
import { HFResource, Resource } from '@nosana/sdk/dist/types/resources.js';

import { HostManager } from '../market/hostManager.js';
import { ContainerOrchestrationInterface } from '../../provider/containerOrchestration/interface.js';
import { NodeRepository } from '../../repository/NodeRepository.js';
import { createResourceName } from './helpers/createResourceName.js';
import { ImageManager, RequiredImage } from './image/imageManager.js';
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

/**
 * A required image as the market endpoint reports it. It reported bare image
 * names before it could carry registry credentials, and the node and the host
 * manager release independently, so a node has to read both shapes: the string
 * form outlives the field it was replaced by.
 */
export type MarketRequiredImage =
  | string
  | {
      name: string;
      server?: string;
      username?: string;
      password?: string;
    };

/**
 * Translates market required images into the shape the pull path reads.
 *
 * Credentials ride along only when the market names an account to pull as. A
 * `server` on its own names a registry without authenticating to it, and the
 * node still pulls from it anonymously, so it is not enough on its own to make
 * the image a private one.
 */
export function normalizeMarketImages(
  required_images: MarketRequiredImage[],
): RequiredImage[] {
  return required_images.map((image) => {
    if (typeof image === 'string') return { name: image };

    const { name, server, username, password } = image;

    if (!username && !password) return { name };

    return { name, auth: { server, username, password } };
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

      await this.images.pullMarketRequiredImages(
        normalizeMarketImages(data.required_images),
      );
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
