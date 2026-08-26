import { DockerAuth } from '@nosana/sdk';

import { applyLoggingProxyToClass } from '../../../monitoring/proxy/loggingProxy.js';
import { ContainerOrchestrationInterface } from '../../../provider/containerOrchestration/interface.js';
import { NodeRepository } from '../../../repository/NodeRepository.js';
import { hoursSinceDate } from '../helpers/hoursSunceDate.js';
import { repoTagsContainsImage } from '../helpers/repoTagsContainsImage.js';

/**
 * An image the market requires, and the registry credentials it takes to pull
 * it. Public images carry none.
 */
export type RequiredImage = {
  name: string;
  auth?: DockerAuth;
};

export class ImageManager {
  private fetched: boolean = false;
  private market_required_images: string[] = [];

  constructor(
    private containerOrchestration: ContainerOrchestrationInterface,
    private repository: NodeRepository,
  ) {
    applyLoggingProxyToClass(this);
  }

  public async pullMarketRequiredImages(
    required_images: RequiredImage[],
  ): Promise<void> {
    this.fetched = true;
    this.market_required_images = required_images.map(({ name }) => name);

    for (const { name, auth } of required_images) {
      if (!(await this.containerOrchestration.hasImage(name))) {
        await this.containerOrchestration.pullImage(name, auth);
      }

      // Written whether or not the image is already known: an image a job
      // pulled first has an entry that says nothing about the market requiring
      // it, and `pruneImages` deletes anything not marked required. `isPrivate`
      // carries the same weight it does for a job image — a credentialed image
      // is dropped rather than left cached — and only takes effect once the
      // market stops requiring this one.
      const known = this.repository.getImageResource(name);

      this.repository.updateImageResource(name, {
        required: true,
        isPrivate: !!auth,
        lastUsed: known?.lastUsed ?? new Date(),
        usage: known?.usage ?? 1,
      });
    }
  }

  public async pruneImages(): Promise<void> {
    const cachedImages = await this.containerOrchestration.listImages();

    for (const { Id, RepoTags } of cachedImages) {
      const dbEntry = Object.entries(this.repository.getImagesResources()).find(
        (img) => (repoTagsContainsImage(img[0], RepoTags) ? img : undefined),
      );

      if (dbEntry && dbEntry[1].required) {
        continue;
      }

      await this.containerOrchestration.deleteImage(Id);

      if (dbEntry) {
        this.repository.deleteImageResource(dbEntry[0]);
      }
    }
  }

  public async resyncImagesDB(): Promise<void> {
    for (const [image, { lastUsed, required, isPrivate }] of Object.entries(
      this.repository.getImagesResources(),
    )) {
      if (!(await this.containerOrchestration.hasImage(image))) {
        this.repository.deleteImageResource(image);
        continue;
      }

      if (
        (!this.fetched && required) ||
        this.market_required_images.includes(image)
      ) {
        continue;
      }

      const hoursSinceLastUsed = hoursSinceDate(new Date(lastUsed));
      if (hoursSinceLastUsed > 24 || isPrivate) {
        await this.containerOrchestration.deleteImage(image);
        this.repository.deleteImageResource(image);
      }
    }
  }

  public async setImage(image: string, isPrivate = false): Promise<void> {
    const imageObj = this.repository.getImageResource(image);
    this.repository.updateImageResource(image, {
      lastUsed: new Date(),
      usage: imageObj?.usage + 1 || 1,
      isPrivate,
    });
  }
}
