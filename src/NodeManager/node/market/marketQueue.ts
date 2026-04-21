import { Client, Market } from "@nosana/sdk";
import { PublicKey } from "@solana/web3.js";
import { getSDK } from "../../sdk";

export class MarketQueue {
  private sdk: Client;
  private market: string;
  private address: PublicKey;
  private checkQueuedInterval?: NodeJS.Timeout;

  constructor(address: PublicKey, market: string) {
    this.sdk = getSDK();
    this.market = market;
    this.address = address;
  }

  public async checkQueuedInMarket(): Promise<Market | undefined> {
    const markets = await this.sdk.jobs.allMarkets();

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
      console.warn('\nCould not update queue status', error);
    }

    // Check market queue status every minute
    this.checkQueuedInterval = setInterval(async () => {
      try {
        const queuedMarketInfo = await this.checkQueuedInMarket();
        updateCallback(queuedMarketInfo);
      } catch (error) {
        console.warn('\nCould not update queue status', error);
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

  public processMarketQueuePosition(): { position: number; count: number } {
    const position =
      this.market.queue.findIndex(
        (e: any) => e.toString() === this.address.toString(),
      ) + 1;
    return {
      position,
      count: this.market.queue.length,
    };
  }
}