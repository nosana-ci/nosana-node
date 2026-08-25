import { describe, it, expect } from "vitest";

import { normalizeMarketImages } from "../resourceManager.js";

/**
 * The market endpoint reported required images as bare names before it could
 * carry registry credentials. A node and the host manager release
 * independently, so both shapes have to reach the pull path as one.
 */
describe("normalizeMarketImages", () => {
  it("reads a bare image name, the shape the endpoint reported before credentials", () => {
    expect(normalizeMarketImages(["ubuntu:24.04"])).toEqual([
      { name: "ubuntu:24.04" },
    ]);
  });

  it("carries the credentials a private image is pulled with", () => {
    const [image] = normalizeMarketImages([
      {
        name: "ghcr.io/org/model:v2",
        server: "ghcr.io",
        username: "nosana",
        password: "hunter2",
      },
    ]);

    expect(image).toEqual({
      name: "ghcr.io/org/model:v2",
      auth: { server: "ghcr.io", username: "nosana", password: "hunter2" },
    });
  });

  it("leaves a public image in the new shape without credentials", () => {
    expect(normalizeMarketImages([{ name: "ubuntu:24.04" }])).toEqual([
      { name: "ubuntu:24.04" },
    ]);
  });

  it("does not authenticate to a server named without an account", () => {
    const [image] = normalizeMarketImages([
      { name: "registry.internal/img", server: "registry.internal" },
    ]);

    expect(image.auth).toBeUndefined();
  });

  it("reads a mixed list, which a market part way through the migration reports", () => {
    const images = normalizeMarketImages([
      "ubuntu:24.04",
      { name: "ghcr.io/org/model:v2", username: "nosana", password: "pw" },
    ]);

    expect(images[0]).toEqual({ name: "ubuntu:24.04" });
    expect(images[1].auth).toMatchObject({
      username: "nosana",
      password: "pw",
    });
  });
});
