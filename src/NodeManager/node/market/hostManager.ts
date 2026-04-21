import { FlowState } from "@nosana/sdk";

import { hostManagerClientSelector } from "../../clients/hostManager/index.js";

export class HostManager {
  public static async register(email: string, discord?: string, twitter?: string): Promise<void> {
    const { data, error } = await hostManagerClientSelector().POST("/nodes/register", {
      body: {
        email,
        discord,
        twitter
      }
    });

    if (error || data?.status !== "registered") {
      throw new Error(`Error registering node${error ? `: ${error}` : ""}`);
    }
  }

  public static async requestMarket(market?: string) {
    const { data, error } = await hostManagerClientSelector().GET("/nodes/request-market", {
      params: {
        query: {
          market
        }
      }
    });

    if (error || !data) {
      console.error("Error requesting market:", error);
      return { market: "TO_BE_DETERMINED", requestedBenchmark: undefined };
    }

    if ("jobDefinition" in data) {
      data.jobDefinition
      return { market: "TO_BE_DETERMINED", requestedBenchmark: data };
    }

    return { market: "TO_BE_DETERMINED", requestedBenchmark: undefined };
  }

  public static async submitBenchmarkResults(benchmarkId: string, result: FlowState) {
    const { data, error } = await hostManagerClientSelector().POST("/operations/{id}/submit-results", {
      params: { path: { id: benchmarkId } },
      body: result,
    });

    if (error && !data) {
      throw new Error(`Error submitting benchmark results: ${error}`);
    }

    return data
  }
}