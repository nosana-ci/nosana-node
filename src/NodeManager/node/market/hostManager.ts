import { JobDefinition } from "@nosana/sdk";

import { hostManagerClientSelector } from "../../clients/hostManager/index.js";
import type { operations } from "../../clients/hostManager/schema.d.ts";

type RequestMarketResponse = operations["getNodesRequest-market"]["responses"][200]["content"]["application/json"];
export type SubmitBenchmarkBody = operations["postBenchmarksByIdSubmit-results"]["requestBody"]["content"]["application/json"];

export type FeedbackReport = NonNullable<RequestMarketResponse["feedbackReport"]>;

export type RequestMarketResult =
  Pick<RequestMarketResponse, "status" | "market" | "feedbackReport"> & {
    notRegistered?: true;
    jobDefinition?: JobDefinition & { id: string };
    benchmarkId?: string;
  };

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

  public static async requestMarket(market?: string): Promise<RequestMarketResult> {
    const { data, error, response } = await hostManagerClientSelector().GET("/nodes/request-market", {
      params: {
        query: {
          market
        }
      }
    });

    if (error || !data) {
      // HTTP 404 = node is not yet registered
      if ((response as any)?.status === 404 || (response as any)?.status === 'NotFound') {
        return { notRegistered: true };
      }
      throw new Error(`Error requesting market: ${error}`);
    }

    const result: RequestMarketResult = {
      status: data.status,
    };

    if (data.jobDefinition) {
      result.jobDefinition = data.jobDefinition as JobDefinition & { id: string };
    }

    if (data.benchmarkId) {
      result.benchmarkId = data.benchmarkId;
    }

    if (data.feedbackReport) {
      result.feedbackReport = data.feedbackReport;
    }

    if (data.market?.address) {
      result.market = {
        address: data.market.address,
        sftTx: data.market.sftTx ?? undefined,
      };
    }

    return result;
  }

  public static async submitBenchmarkResults(benchmarkId: string, body: SubmitBenchmarkBody) {
    const { data, error } = await hostManagerClientSelector().POST("/benchmarks/{id}/submit-results", {
      params: { path: { id: benchmarkId } },
      body,
    });

    if (error && !data) {
      throw new Error(`Error submitting benchmark results: ${JSON.stringify(error)}`);
    }

    return data;
  }

  public static async syncNodeAfterMint(address: string): Promise<void> {
    const { error } = await hostManagerClientSelector().POST("/nodes/sync-node", {
      body: { address },
    });

    if (error) {
      throw new Error(`Error syncing node after mint: ${error}`);
    }
  }

}