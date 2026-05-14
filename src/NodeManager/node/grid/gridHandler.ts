import { KeyWallet, Market, Run, Client as SDK } from "@nosana/sdk";
import { applyLoggingProxyToClass } from "../../monitoring/proxy/loggingProxy.js";
import { NodeRepository } from "../../repository/NodeRepository.js";
import {
  BlockheightBasedTransactionConfirmationStrategy,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import { getRawTransaction } from '../../sdk/index.js';
import { HostManager } from '../market/hostManager.js';
import { sleep } from '../../utils/utils.js';

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

  public async getNodeStatus(): Promise<NodeData> {
    try {
      const data = await HostManager.getNode(this.address.toString());

      if (!data) throw new Error('Node not found');

      return {
        status: data.status,
        market: data.marketAddress ?? undefined,
      };
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        error.message.includes("Node not onboarded yet")
      ) {
        throw new Error(
          "Node is still on the waitlist, wait until you are accepted."
        );
      } else if (
        error instanceof Error &&
        !error.message.includes("Node not found")
      ) {
        throw error;
      }

      return {
        status: "not-found",
        market: undefined,
      };
    }
  }
}
