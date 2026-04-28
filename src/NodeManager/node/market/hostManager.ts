import { FlowState, JobDefinition } from "@nosana/sdk";

import { hostManagerClientSelector } from "../../clients/hostManager/index.js";
import type { operations } from "../../clients/hostManager/schema.d.ts";

type RequestMarketResponse = operations["getNodesRequest-market"]["responses"][200]["content"]["application/json"];
export type SubmitBenchmarkBody = operations["postBenchmarksByIdSubmit-results"]["requestBody"]["content"]["application/json"];

export function serializeFlowState(result: FlowState): SubmitBenchmarkBody {
  return {
    status: result.status,
    startTime: result.startTime,
    endTime: result.endTime,
    errors: result.errors,
    opStates: (result.opStates ?? []).map((op) => ({
      providerId: op.providerId,
      operationId: op.operationId,
      group: op.group,
      status: op.status,
      startTime: op.startTime,
      endTime: op.endTime,
      exitCode: op.exitCode ?? null,
      logs: op.logs,
      diagnostics: op.diagnostics
        ? {
            reason: op.diagnostics.reason,
            state: typeof op.diagnostics.state === "object"
              ? JSON.stringify(op.diagnostics.state)
              : op.diagnostics.state,
          }
        : undefined,
    })),
  };
}

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
}