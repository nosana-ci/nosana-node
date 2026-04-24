import { FlowState, JobDefinition } from "@nosana/sdk";

import { hostManagerClientSelector } from "../../clients/hostManager/index.js";
import type { operations } from "../../clients/hostManager/schema.d.ts";

type RequestMarketResponse = operations["getNodesRequest-market"]["responses"][200]["content"]["application/json"];

export type FeedbackReport = NonNullable<RequestMarketResponse["feedbackReport"]>;

export type RequestMarketResult =
  Pick<RequestMarketResponse, "status" | "market" | "feedbackReport"> & {
    notRegistered?: true;
    jobDefinition?: JobDefinition & { id: string };
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
      if (response && response.status === 404) {
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

  public static async submitBenchmarkResults(benchmarkId: string, result: FlowState) {
    const { data, error } = await hostManagerClientSelector().POST("/operations/{id}/submit-results", {
      params: { path: { id: benchmarkId } },
      body: result,
    });

    if (error && !data) {
      throw new Error(`Error submitting benchmark results: ${error}`);
    }

    return data;
  }
}