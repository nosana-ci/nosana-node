import { KeyWallet, Market, Run, Client as SDK } from '@nosana/sdk';
import { applyLoggingProxyToClass } from '../../monitoring/proxy/loggingProxy.js';
import { NodeRepository } from '../../repository/NodeRepository.js';
import {
  BlockheightBasedTransactionConfirmationStrategy,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import { getRawTransaction } from '../../sdk/index.js';
import { sleep } from '../../utils/utils.js';
import { configs } from '../../configs/configs.js';

export interface NodeData {
  market?: string;
  status: string;
}

export class GridHandler {
  private address: PublicKey;

  constructor(private sdk: SDK, private repository: NodeRepository) {
    this.address = this.sdk.solana.provider!.wallet.publicKey;
    applyLoggingProxyToClass(this);
  }

  private async getAuthSignature(): Promise<string> {
    const signature = (await this.sdk.solana.signMessage(
      configs().signMessage,
    )) as Uint8Array;
    return Buffer.from(signature).toString('base64');
  }

  public async getNodeStatus(): Promise<NodeData> {
    try {
      const response = await fetch(
        `${configs().backendUrl}/nodes/${this.address}`,
        {
          method: 'GET',
          headers: {
            Authorization: `${this.address}:${await this.getAuthSignature()}`,
            'Content-Type': 'application/json',
          },
        },
      );
      const data = await response.json();

      if (!data || (data.name === 'Error' && data.message))
        throw new Error(data.message);

      return {
        status: data.status,
        market: data.marketAddress,
      };
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        error.message.includes('Node not onboarded yet')
      ) {
        throw new Error(
          'Node is still on the waitlist, wait until you are accepted.',
        );
      } else if (
        error instanceof Error &&
        !error.message.includes('Node not found')
      ) {
        throw error;
      }

      return {
        status: 'not-found',
        market: undefined,
      };
    }
  }
}
