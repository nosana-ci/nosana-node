import chalk from "chalk";
import { Client as SDK, Market } from "@nosana/sdk";
import { PublicKey } from "@solana/web3.js";

import { HostManager, FeedbackReport } from "./hostManager.js";
import { Benchmark } from "./benchmark.js";
import { NodeNotRegisteredError } from "../../errors/NodeNotRegisteredError.js";
import { NodeBannedError } from "../../errors/NodeBannedError.js";
import { NodeNotQualifiedError } from "../../errors/NodeNotQualifiedError.js";
import { Provider } from "../../provider/Provider.js";
import { NodeRepository } from "../../repository/NodeRepository.js";
import { MarketAccessHandler } from "./marketAccess.js";
import { sleep } from "../../utils/utils.js";

export class MarketHandler {
  private market: Market | undefined;
  private address: PublicKey;
  private checkQueuedInterval?: NodeJS.Timeout; // Interval to check market queue
  private marketAccessHandler: MarketAccessHandler;

  private inMarket = false;

  constructor(
    private sdk: SDK,
    private provider: Provider,
    private repository: NodeRepository,
  ) {
    this.address = this.sdk.solana.provider!.wallet.publicKey;
    this.marketAccessHandler = new MarketAccessHandler(this.sdk);
  }

  public clear(): void {
    this.market = undefined;
  }

  public isInMarket(): boolean {
    return this.inMarket;
  }

  public setInMarket() {
    this.inMarket = true;
  }

  public async request(requestedMarket?: string): Promise<Market> {
    const result = await HostManager.requestMarket(requestedMarket);
    // Not registered - caller will handle registration and retry
    if (result.notRegistered) {
      throw new NodeNotRegisteredError();
    }

    // Node is banned
    if (result.status === "REJECTED") {
      throw new NodeBannedError();
    }

    // Host manager wants us to run a benchmark first
    if (result.jobDefinition) {
      const benchmark = new Benchmark(
        result.benchmarkId ?? result.jobDefinition.id,
        result.jobDefinition,
        this.sdk,
        this.provider,
        this.repository,
      );
      await benchmark.run();
      return await this.request(requestedMarket);
    }

    // Show feedback report for visibility
    if (result.feedbackReport) {
      this.logFeedbackReport(result.feedbackReport);
    }

    // Sign and send SFT mint/burn transaction if provided
    if (result.market?.sftTx) {
      await this.marketAccessHandler.mintAccessKey(result.market.sftTx);
      await sleep(30);
      await HostManager.syncNodeAfterMint(this.address.toString());
    }

    // feedbackReport failed with no market -> node doesn't qualify for any market
    if (
      result.feedbackReport &&
      !result.feedbackReport.passed &&
      !result.market
    ) {
      throw new NodeNotQualifiedError();
    }

    // feedbackReport failed but a market is present -> node is PREMIUM, continue
    if (
      result.feedbackReport &&
      !result.feedbackReport.passed &&
      result.market
    ) {
      console.log(
        chalk.yellow(
          "Some thresholds not met, but market access granted. Continuing.",
        ),
      );
    }

    if (!result.market?.address) {
      throw new NodeNotQualifiedError();
    }

    const onchainMarket = await this.sdk.jobs.getMarket(result.market.address);
    if (!onchainMarket) {
      throw new Error(
        `Requested market ${result.market.address} not found on-chain`,
      );
    }

    this.market = onchainMarket;
    return onchainMarket;
  }

  private logFeedbackReport(report: FeedbackReport): void {
    const passed = report.metrics.filter((m) => m.passed);
    const failed = report.metrics.filter((m) => !m.passed);

    console.log("\n" + chalk.bgCyan.black.bold("  THRESHOLD REPORT  ") + "\n");

    for (const metric of report.metrics) {
      const measuredStr =
        metric.measuredValue !== undefined
          ? chalk.gray(` (measured: ${metric.measuredValue})`)
          : "";

      if (metric.passed) {
        console.log(
          chalk.green("  ✔ ") + chalk.bold(metric.metricKey) + measuredStr,
        );
      } else {
        console.log(
          chalk.red("  ✖ ") + chalk.bold(metric.metricKey) + measuredStr,
        );
        if (metric.failureMessage) {
          console.log(chalk.yellow(`    ↳ ${metric.failureMessage}`));
        }
      }
    }

    if (report.passed) {
      console.log(
        chalk.bgGreen.black.bold(
          `  ${passed.length}/${report.metrics.length} threshold(s) passed  `,
        ) + "\n",
      );
    } else {
      console.log(
        chalk.bgYellow.black.bold(
          `  ${passed.length}/${report.metrics.length} threshold(s) passed — ${failed.length} failed  `,
        ) + "\n",
      );
    }
  }

  public async check(market: string): Promise<Market> {
    try {
      return await this.sdk.jobs.getMarket(market);
    } catch (error) {
      throw new Error(`Error resolving Market: ${error}`);
    }
  }

  public async stopMarket(): Promise<boolean> {
    if (this.market) {
      try {
        await this.sdk.jobs.stop(this.market.address);
      } catch (e: any) {
        return false;
      }
    }
    return true;
  }

  public async getJobMarket(market: string): Promise<Market> {
    try {
      this.market = await this.sdk.jobs.getMarket(market);
      return this.market;
    } catch (error) {
      throw new Error("market does not exists");
    }
  }

  public getMarket(): Market | undefined {
    return this.market;
  }

  public async setMarket(market: string): Promise<Market> {
    try {
      this.market = await this.sdk.jobs.getMarket(market);
      return this.market;
    } catch (error) {
      throw new Error("market does not exists");
    }
  }

  public async checkQueuedInMarket(): Promise<Market | undefined> {
    let markets = [];

    markets = await this.sdk.jobs.allMarkets();

    for (const market of markets) {
      if (
        market?.queue?.some(
          (e: PublicKey) => e.toString() === this.address.toString(),
        )
      ) {
        this.market = market;
        return this.getMarket();
      }
    }

    return undefined;
  }

  public async join(accessKey?: PublicKey): Promise<Market> {
    if (!this.market) {
      throw new Error("market not defined");
    }
    try {
      await this.sdk.jobs.work(this.market.address, accessKey);
      this.inMarket = true;
    } catch (e) {
      throw new Error(`could not join queue: ${e}`);
    }

    return this.market;
  }

  public async refresh(): Promise<Market> {
    return this.setMarket(this.market?.address.toString() as string);
  }

  public async leave(): Promise<void> {
    if (this.market) {
      try {
        await this.sdk.jobs.stop(this.market.address);
      } catch (error) {}
      this.inMarket = false;
    }
  }

  public processMarketQueuePosition(market: Market, isFirst: boolean) {
    const position =
      market.queue.findIndex(
        (e: any) => e.toString() === this.address.toString(),
      ) + 1;
    return {
      position,
      count: market.queue.length,
    };
  }

  public async startMarketQueueMonitoring(
    updateCallback: (market: Market | undefined) => void,
  ): Promise<void> {
    // Ensure no multiple intervals
    this.stopMarketQueueMonitoring();

    try {
      // Perform an immediate check
      const queuedMarketInfo = await this.checkQueuedInMarket();
      updateCallback(queuedMarketInfo);
    } catch (error) {
      console.warn("\nCould not update queue status", error);
    }

    // Check market queue status every minute
    this.checkQueuedInterval = setInterval(async () => {
      try {
        const queuedMarketInfo = await this.checkQueuedInMarket();
        updateCallback(queuedMarketInfo);
      } catch (error) {
        console.warn("\nCould not update queue status", error);
      }
    }, 60000);
  }

  // Stop monitoring market queue status
  public stopMarketQueueMonitoring(): void {
    if (this.checkQueuedInterval) {
      clearInterval(this.checkQueuedInterval);
      this.checkQueuedInterval = undefined; // Clean up reference
    }
  }

  public async stop(): Promise<void> {
    this.stopMarketQueueMonitoring();
    await this.leave();
    this.clear();
  }

  public async clean(): Promise<void> {
    this.stopMarketQueueMonitoring();
    this.clear();
  }
}
