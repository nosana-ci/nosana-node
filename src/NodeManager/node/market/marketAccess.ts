import { KeyWallet, Client as SDK } from '@nosana/sdk';
import { VersionedTransaction } from '@solana/web3.js';

import { HostManager } from './hostManager.js';

/**
 * The host-manager builds the access-key transaction, co-signs it with the
 * mint authority and submits it. We only sign it as fee payer.
 */
export class MarketAccessHandler {
  constructor(private sdk: SDK) {}

  public async submitAccessKey(accessKeyTx: string): Promise<string> {
    const result = await HostManager.submitAccessKeyTx(
      this.signAsFeePayer(accessKeyTx),
    );

    if (result.status !== 'confirmed' || !result.signature) {
      throw new Error(
        `Access key transaction ${result.status}${
          result.reason ? `: ${result.reason}` : ''
        }`,
      );
    }

    return result.signature;
  }

  private signAsFeePayer(txBase64: string): string {
    const feePayer = (this.sdk.solana.provider?.wallet as KeyWallet).payer;
    const transaction = VersionedTransaction.deserialize(
      Buffer.from(txBase64, 'base64'),
    );

    transaction.sign([feePayer]);

    return Buffer.from(transaction.serialize()).toString('base64');
  }
}
