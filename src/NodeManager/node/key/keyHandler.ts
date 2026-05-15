import { Market, Client as SDK } from '@nosana/sdk';
import { PublicKey } from '@solana/web3.js';
import { EMPTY_ADDRESS } from '../../jobs/index.js';

export class KeyHandler {
  private address: PublicKey;
  private key: PublicKey | undefined;
  private market: PublicKey | undefined;

  constructor(private sdk: SDK) {
    this.address = this.sdk.solana.provider!.wallet.publicKey;
  }

  getMarket(): PublicKey | undefined {
    return this.market;
  }

  setMarket(market?: PublicKey) {
    this.market = market;
  }

  getAccessKey(): PublicKey | undefined {
    return this.key;
  }

  setAccessKey(key?: PublicKey) {
    this.key = key;
  }

  doesMarketNeedAccessKey(market: Market): boolean {
    if (market!.nodeAccessKey.toString() === EMPTY_ADDRESS.toString()) {
      return false;
    }

    return true;
  }

  async loadAccessKeyFromChain(market: Market): Promise<PublicKey | undefined> {
    try {
      this.key = await this.sdk.solana.getNftFromCollection(
        this.address,
        market!.nodeAccessKey.toString()
      );

      if (!this.key) {
        throw new Error("Could not find access key");
      }

      return this.key;
    } catch (error) {
      throw new Error(`error loading Access Key from chain: ${error}`);
    }
  }
}
