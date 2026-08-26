import { describe, it, expect, vi, beforeEach } from "vitest";

import { ImageManager } from "../imageManager.js";
import { NodeRepository } from "../../../../repository/NodeRepository.js";
import { ContainerOrchestrationInterface } from "../../../../provider/containerOrchestration/interface.js";
import { ResourceHistory } from "../../../../db/index.js";

const AUTH = { server: "ghcr.io", username: "nosana", password: "hunter2" };

function makeMocks(cached: string[] = []) {
  const images: Record<string, ResourceHistory> = {};

  const repository = {
    getImageResource: vi.fn((image: string) => images[image]),
    getImagesResources: vi.fn(() => images),
    updateImageResource: vi.fn(
      (image: string, fields: Partial<ResourceHistory>) => {
        images[image] = { ...images[image], ...fields } as ResourceHistory;
      }
    ),
    deleteImageResource: vi.fn((image: string) => {
      delete images[image];
    }),
  } as unknown as NodeRepository;

  const containerOrchestration = {
    hasImage: vi.fn(async (image: string) => cached.includes(image)),
    pullImage: vi.fn(async () => {}),
    listImages: vi.fn(async () => []),
    deleteImage: vi.fn(async () => {}),
  } as unknown as ContainerOrchestrationInterface;

  return { images, repository, containerOrchestration };
}

describe("pullMarketRequiredImages", () => {
  let mocks: ReturnType<typeof makeMocks>;

  beforeEach(() => {
    mocks = makeMocks();
  });

  const manager = () =>
    new ImageManager(mocks.containerOrchestration, mocks.repository);

  it("pulls a private image with the credentials the market gave for it", async () => {
    await manager().pullMarketRequiredImages([
      { name: "ghcr.io/org/model:v2", auth: AUTH },
    ]);

    expect(mocks.containerOrchestration.pullImage).toHaveBeenCalledWith(
      "ghcr.io/org/model:v2",
      AUTH
    );
  });

  it("pulls a public image anonymously", async () => {
    await manager().pullMarketRequiredImages([{ name: "ubuntu:24.04" }]);

    expect(mocks.containerOrchestration.pullImage).toHaveBeenCalledWith(
      "ubuntu:24.04",
      undefined
    );
  });

  it("marks a credentialed image private, so it is dropped once no longer required", async () => {
    await manager().pullMarketRequiredImages([
      { name: "ghcr.io/org/model:v2", auth: AUTH },
      { name: "ubuntu:24.04" },
    ]);

    expect(mocks.images["ghcr.io/org/model:v2"]).toMatchObject({
      required: true,
      isPrivate: true,
    });
    expect(mocks.images["ubuntu:24.04"]).toMatchObject({
      required: true,
      isPrivate: false,
    });
  });

  it("records an image a job pulled first as required, which prune reads", async () => {
    const lastUsed = new Date("2026-01-01T00:00:00.000Z");
    mocks.images["ghcr.io/org/model:v2"] = {
      lastUsed,
      usage: 3,
    } as unknown as ResourceHistory;

    await manager().pullMarketRequiredImages([
      { name: "ghcr.io/org/model:v2", auth: AUTH },
    ]);

    expect(mocks.images["ghcr.io/org/model:v2"]).toEqual({
      lastUsed,
      usage: 3,
      required: true,
      isPrivate: true,
    });
  });

  it("does not re-pull an image already on the node", async () => {
    mocks = makeMocks(["ghcr.io/org/model:v2"]);

    await manager().pullMarketRequiredImages([
      { name: "ghcr.io/org/model:v2", auth: AUTH },
    ]);

    expect(mocks.containerOrchestration.pullImage).not.toHaveBeenCalled();
    expect(mocks.images["ghcr.io/org/model:v2"]).toMatchObject({
      required: true,
    });
  });

  it("keeps a required private image while the market still requires it", async () => {
    const instance = manager();

    await instance.pullMarketRequiredImages([
      { name: "ghcr.io/org/model:v2", auth: AUTH },
    ]);

    (
      mocks.containerOrchestration.hasImage as ReturnType<typeof vi.fn>
    ).mockResolvedValue(true);

    await instance.resyncImagesDB();

    expect(mocks.containerOrchestration.deleteImage).not.toHaveBeenCalled();
    expect(mocks.images["ghcr.io/org/model:v2"]).toBeDefined();
  });
});
