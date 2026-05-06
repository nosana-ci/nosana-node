import { JobDefinition } from "@nosana/sdk";

import { hostManagerClientSelector } from "../../clients/hostManager/index.js";
import type { operations } from "../../clients/hostManager/schema.d.ts";

type RequestMarketResponse = operations["getNodesRequest-market"]["responses"][200]["content"]["application/json"];
export type SubmitBenchmarkBody = operations["postBenchmarksByIdSubmit-results"]["requestBody"]["content"]["application/json"];
type GetNodeResponse = operations["getNodesById"]["responses"][200]["content"]["application/json"];
type RequiredResourcesResponse = operations["getMarketsByIdRequired-resources"]["responses"][200]["content"]["application/json"];
type HeartbeatResponse = operations["postNodesHeartbeat"]["responses"][200]["content"]["application/json"];
type RpcResponse = operations["getRpc"]["responses"][200]["content"]["application/json"];
type ErrorReportBody = operations["postErrorsReport"]["requestBody"]["content"]["application/json"];

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

    if (data.market) {
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

  public static async getNode(address: string): Promise<GetNodeResponse | null> {
    const { data, error, response } = await hostManagerClientSelector().GET("/nodes/{id}", {
      params: { path: { id: address } },
    });

    if (error || !data) {
      if ((response as any)?.status === 404 || (response as any)?.status === 'NotFound') {
        return null;
      }
      throw new Error(`Error getting node: ${JSON.stringify(error)}`);
    }

    return data;
  }

  public static async getMarketRequiredResources(
    marketId: string,
  ): Promise<RequiredResourcesResponse | null> {
    const { data, error } = await hostManagerClientSelector().GET(
      "/markets/{id}/required-resources",
      {
        params: { path: { id: marketId } },
      },
    );

    if (error || !data) {
      return null;
    }

    return data;
  }

  public static async sendHeartbeat(): Promise<HeartbeatResponse> {
    const { data, error } = await hostManagerClientSelector().POST("/nodes/heartbeat", {});

    if (error || !data) {
      throw new Error(`Error sending heartbeat: ${JSON.stringify(error)}`);
    }

    return data;
  }

  public static async getRpcUrl(): Promise<string | undefined> {
    const { data, error } = await hostManagerClientSelector().GET("/rpc", {});

    if (error || !data) {
      throw new Error(`Error fetching host-manager RPC URL: ${JSON.stringify(error)}`);
    }

    return typeof data.url === "string" ? data.url : undefined;
  }

  public static async reportError(body: ErrorReportBody) {
    const { data, error } = await hostManagerClientSelector().POST("/errors/report", {
      body,
    });

    if (error || !data) {
      throw new Error(`Error reporting node error: ${JSON.stringify(error)}`);
    }

    return data;
  }

}