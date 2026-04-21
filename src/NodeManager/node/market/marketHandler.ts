import { Client as SDK, JobDefinition, Market } from '@nosana/sdk';

import { HostManager } from './hostManager.js';
import { MarketQueue } from './marketQueue.js';
import TaskManager from '../task/TaskManager.js';
import { Provider } from '../../provider/Provider.js';
import { NodeRepository } from '../../repository/NodeRepository.js';

export class MarketHandler {
  private market: Market | null = null;

  constructor(
    private sdk: SDK,
    private provider: Provider,
    private repository: NodeRepository
  ) { }

  public isInMarket(): boolean {
    return !!this.market
  }

  public getMarket(): Market | null {
    return this.market;
  }

  public async request(requestedMarket?: string): Promise<Market> {
    const { market, requestedBenchmark } = await HostManager.requestMarket(requestedMarket);

    if (requestedBenchmark) {
      await this.runRequestedBenchmark(requestedBenchmark);
      return await this.request(requestedMarket);
    }

    const onchainMarket = await this.sdk.jobs.getMarket(market);
    if (!onchainMarket) {
      throw new Error(`Requested market ${market} not found on-chain`);
    }

    this.market = onchainMarket;
    return onchainMarket;
  }

  public async join(market: Market): Promise<void> {

  }

  private async runRequestedBenchmark(requestedBenchmark: { benchmarkId: string; jobDefinition: JobDefinition }) {
    const task = new TaskManager(
      this.provider,
      this.repository,
      requestedBenchmark.benchmarkId,
      this.sdk.solana.wallet.publicKey.toString(),
      requestedBenchmark.jobDefinition,
    );

    try {
      task.bootstrap();
      await task.start();
    } catch (error) {
      console.error('Error running benchmark:', error);
    }
  }

  public async stop(): Promise<void> {

  }
}
