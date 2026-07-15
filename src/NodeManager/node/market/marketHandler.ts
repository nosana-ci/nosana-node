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

const RETEST_BUFFER_S = 60;
const MAX_BENCHMARK_RETRIES = 3;

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

  public async request(
    requestedMarket?: string,
    session?: string,
    benchmarkRetries = 0,
  ): Promise<Market> {
    const result = await HostManager.requestMarket(requestedMarket, session);

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
      // Re-poll within the same request-market cycle, echoing the session the
      // host issued so lifecycle metrics aren't re-requested on the retry.
      return await this.request(requestedMarket, result.session ?? session, benchmarkRetries);
    }

    // Sign and send SFT mint/burn transaction if provided
    if (result.market?.sftTx) {
      await this.marketAccessHandler.mintAccessKey(result.market.sftTx);
      await sleep(30);
      await HostManager.syncNodeAfterMint(this.address.toString());
    }

    await this.logLatestMeasurements();

    if (result.feedbackReport) {
      this.logFeedbackReport(result.feedbackReport);
    }

    if (!result.market?.address) {
      const nextTestAt = parseFutureDate(result.nextTestAt);

      if (nextTestAt && benchmarkRetries < MAX_BENCHMARK_RETRIES) {
        const waitSeconds =
          Math.ceil((nextTestAt.getTime() - Date.now()) / 1000) +
          RETEST_BUFFER_S;

        console.log(
          chalk.yellow(
            `Node does not qualify for a market yet. Next eligible retest at ${nextTestAt.toISOString()}, retrying in ~${Math.ceil(waitSeconds / 60)} minutes.`,
          ),
        );

        await sleep(waitSeconds);
        return await this.request(requestedMarket, undefined, benchmarkRetries + 1);
      }

      throw new NodeNotQualifiedError(result.nextTestAt);
    }

    const onchainMarket = await this.sdk.jobs.getMarket(result.market.address);
    if (!onchainMarket) {
      throw new Error(
        `Requested market ${result.market.address} not found on-chain`,
      );
    }

    if (result.feedbackReport && !result.feedbackReport.passed) {
      console.log(
        chalk.yellow(
          "Some thresholds are still below the target market requirements, but access was granted. Continuing.",
        ),
      );
    }

    this.market = onchainMarket;
    return onchainMarket;
  }

  private logFeedbackReport(report: FeedbackReport): void {
    const targetMarketLabel = report.marketName ?? report.marketAddress;

    const requiredMetrics = report.metrics.filter((m) => !m.isOptional);
    const optionalMetrics = report.metrics.filter((m) => m.isOptional);

    let nameWidth = 24;
    let passedRequired = 0;
    for (const metric of report.metrics) {
      if (metric.metricKey.length > nameWidth) nameWidth = metric.metricKey.length;
    }
    for (const metric of requiredMetrics) {
      if (metric.passed) passedRequired++;
    }
    const totalRequired = requiredMetrics.length;
    const failedRequired = totalRequired - passedRequired;

    const printMetric = (metric: FeedbackReport["metrics"][number]) => {
      const icon = metric.passed ? chalk.green("  ✔ ") : chalk.red("  ✖ ");
      const measuredStr =
        metric.measuredValue !== undefined && metric.measuredValue !== null
          ? `  ${chalk.cyan(metric.measuredValue)}`
          : "";

      console.log(icon + chalk.bold(metric.metricKey.padEnd(nameWidth)) + measuredStr);
      console.log(chalk.gray(`    rule: ${metric.ruleDescription}`));
    };

    console.log("\n" + chalk.bgCyan.black.bold("  TARGET MARKET  ") + "\n");
    console.log(`  ${chalk.bold(targetMarketLabel)}`);
    console.log();

    for (const metric of requiredMetrics) {
      printMetric(metric);
    }

    if (optionalMetrics.length > 0) {
      console.log();
      console.log(`  ${chalk.bold.underline("Optional thresholds")}`);
      console.log(chalk.gray(`  (do not block market access)`));
      console.log();
      for (const metric of optionalMetrics) {
        printMetric(metric);
      }
    }

    console.log();

    if (report.passed) {
      console.log(
        chalk.bgGreen.black.bold(
          `  Node currently meets all ${totalRequired} market requirements for ${targetMarketLabel}  `,
        ) + "\n",
      );
    } else {
      console.log(
        chalk.bgYellow.black.bold(
          `  Node currently meets ${passedRequired} of ${totalRequired} market requirements for ${targetMarketLabel} — ${failedRequired} still need improvement  `,
        ) + "\n",
      );
    }
  }

  private async logLatestMeasurements(): Promise<void> {
    let response;
    try {
      response = await HostManager.getNodeMetrics(this.address.toString());
    } catch (error) {
      console.warn(chalk.yellow("Could not fetch latest measurements:"), error);
      return;
    }

    const rawMetrics = response?.metrics as Record<string, unknown> | undefined;
    if (!rawMetrics) return;

    const flat = flattenMetrics(rawMetrics);
    if (flat.length === 0) return;

    const nameWidth = Math.max(20, ...flat.map(([key]) => key.length));
    const width = nameWidth + 30;

    console.log();
    console.log("  " + chalk.cyan("━".repeat(width)));
    console.log("  " + chalk.bold.cyan("LATEST MEASUREMENTS"));
    console.log("  " + chalk.cyan("━".repeat(width)));
    console.log();

    for (const [key, value] of flat) {
      const name = chalk.bold(key.padEnd(nameWidth));
      const details = chalk.cyan(value);
      console.log(`  ${chalk.cyan("•")}  ${name}  ${details}`);
    }

    console.log();
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
      } catch (error) { }
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

function parseFutureDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
    return undefined;
  }
  return date;
}

function flattenMetrics(
  obj: Record<string, unknown>,
  prefix = "",
): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        const indexed = `${fullKey}[${i}]`;
        if (item && typeof item === "object") {
          result.push(...flattenMetrics(item as Record<string, unknown>, indexed));
        } else {
          result.push([indexed, String(item)]);
        }
      });
    } else if (value && typeof value === "object") {
      result.push(...flattenMetrics(value as Record<string, unknown>, fullKey));
    } else if (value !== null && value !== undefined) {
      result.push([fullKey, String(value)]);
    }
  }
  return result;
}
