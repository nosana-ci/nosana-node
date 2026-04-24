import chalk from 'chalk';
import { Client as SDK, Market } from '@nosana/sdk';
import {
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';

import { HostManager, FeedbackReport } from './hostManager.js';
import { Benchmark } from './benchmark.js';
import { NodeNotRegisteredError } from '../../errors/NodeNotRegisteredError.js';
import { NodeBannedError } from '../../errors/NodeBannedError.js';
import { NodeNotQualifiedError } from '../../errors/NodeNotQualifiedError.js';
import { Provider } from '../../provider/Provider.js';
import { NodeRepository } from '../../repository/NodeRepository.js';
import { getRawTransaction } from '../../sdk/index.js';

export class MarketHandler {
  private market: Market | null = null;

  constructor(
    private sdk: SDK,
    private provider: Provider,
    private repository: NodeRepository
  ) { }

  public isInMarket(): boolean {
    return !!this.market;
  }

  public getMarket(): Market | null {
    return this.market;
  }

  public async request(requestedMarket?: string): Promise<Market> {
    const result = await HostManager.requestMarket(requestedMarket);

    // Not registered - caller will handle registration and retry
    if (result.notRegistered) {
      throw new NodeNotRegisteredError();
    }

    // Node is banned
    if (result.status === 'REJECTED') {
      throw new NodeBannedError();
    }

    // Host manager wants us to run a benchmark first
    if (result.jobDefinition) {
      const benchmark = new Benchmark(
        result.jobDefinition.id,
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

    // feedbackReport failed with no market -> node doesn't qualify for any market
    if (result.feedbackReport && !result.feedbackReport.passed && !result.market) {
      throw new NodeNotQualifiedError();
    }

    // feedbackReport failed but a market is present -> node is PREMIUM, continue
    if (result.feedbackReport && !result.feedbackReport.passed && result.market) {
      console.log(chalk.yellow('Some thresholds not met, but market access granted. Continuing.'));
    }

    if (!result.market?.address) {
      throw new Error('No market address received from request-market response.');
    }

    // Sign and send SFT mint transaction if provided
    if (result.market.sftTx) {
      await this.executeSftTransaction(result.market.sftTx);
    }

    const onchainMarket = await this.sdk.jobs.getMarket(result.market.address);
    if (!onchainMarket) {
      throw new Error(`Requested market ${result.market.address} not found on-chain`);
    }

    this.market = onchainMarket;
    return onchainMarket;
  }

  private async executeSftTransaction(sftTxBase64: string): Promise<void> {
    // TODO
  }

  private logFeedbackReport(report: FeedbackReport): void {
    const passed = report.metrics.filter(m => m.passed);
    const failed = report.metrics.filter(m => !m.passed);

    console.log('\n' + chalk.bgCyan.black.bold('  THRESHOLD REPORT  ') + '\n');

    for (const metric of report.metrics) {
      const measuredStr = metric.measuredValue !== undefined
        ? chalk.gray(` (measured: ${metric.measuredValue})`)
        : '';

      if (metric.passed) {
        console.log(chalk.green('  ✔ ') + chalk.bold(metric.metricKey) + measuredStr);
      } else {
        console.log(chalk.red('  ✖ ') + chalk.bold(metric.metricKey) + measuredStr);
        if (metric.failureMessage) {
          console.log(chalk.yellow(`    ↳ ${metric.failureMessage}`));
        }
      }
    }

    if (report.passed) {
      console.log(chalk.bgGreen.black.bold(`  ${passed.length}/${report.metrics.length} threshold(s) passed  `) + '\n');
    } else {
      console.log(chalk.bgYellow.black.bold(`  ${passed.length}/${report.metrics.length} threshold(s) passed — ${failed.length} failed  `) + '\n');
    }
  }

  public async join(market: Market): Promise<void> {

  }

  public async stop(): Promise<void> {

  }
}
