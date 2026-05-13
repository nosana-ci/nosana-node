import { KeyWallet, Market, Run, Client as SDK } from "@nosana/sdk";
import { applyLoggingProxyToClass } from "../../monitoring/proxy/loggingProxy.js";
import { NodeRepository } from "../../repository/NodeRepository.js";
import {
  BlockheightBasedTransactionConfirmationStrategy,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import { getRawTransaction } from "../../sdk/index.js";
import { sleep } from "../../utils/utils.js";
import { clientSelector } from "../../client/index.js";

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
      const { data, error } = await clientSelector({ withAuth: true }).GET(
        // @ts-expect-error: route not yet in OpenAPI schema
        "/api/nodes/{address}",
        {
          params: { path: { address: this.address.toString() } },
        }
      );

      const body = (data ?? error) as
        | {
            name?: string;
            message?: string;
            status: string;
            marketAddress?: string;
          }
        | undefined;

      if (!body || (body.name === "Error" && body.message))
        throw new Error(body?.message);

      return {
        status: body.status,
        market: body.marketAddress,
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

  async recommend(): Promise<any> {
    const gpus = this.repository.getNodeInfo().gpus;

    try {
      const { data: success, error: failure } = await clientSelector({
        withAuth: true,
      }).POST(
        // @ts-expect-error: route not yet in OpenAPI schema
        "/api/nodes/{address}/check-market",
        {
          params: { path: { address: this.address.toString() } },
          body: { gpus: JSON.stringify(gpus) },
        }
      );

      let data: any = success ?? failure;

      if (!data) {
        throw new Error(
          "Something went wrong with recommending the market, please try again."
        );
      }

      if (data.needsChangeMarket) {
        data = await this.changeMarket();
        return data.newMarket;
      }

      if (data.address) {
        return data.address;
      }

      if (data.message) {
        throw new Error(data.message);
      }
    } catch (error) {
      throw error;
    }
  }

  private async changeMarket(): Promise<any> {
    try {
      const { data: success, error: failure } = await clientSelector({
        withAuth: true,
      }).POST(
        // @ts-expect-error: route not yet in OpenAPI schema
        "/api/nodes/change-market",
        {
          body: { address: this.address.toString() },
        }
      );

      const data: any = success ?? failure;
      if (!data || data.name === "Error") throw new Error(data.message);

      // Incase of blockheight exceeded error, retry 3 times
      for (let i = 0; i < 3; i++) {
        try {
          const txnSignature = await this.signAndSendTransaction(data.tx);
          await this.confirmTransaction(txnSignature);
          break;
        } catch (error: any) {
          if (
            i === 2 ||
            !error?.message.includes(
              "TransactionExpiredBlockheightExceededError"
            )
          ) {
            throw error;
          }
        }
      }
      // TODO: verify tx result with code below
      // const result = await this.sdk.solana.connection?.getTransaction(
      //   txnSignature as string,
      //   { maxSupportedTransactionVersion: 0 },
      // );
      // // @ts-ignore
      // if (result?.meta?.status.Err) {
      //   // @ts-ignore
      //   throw new Error(JSON.stringify(result?.meta?.status.Err));
      // }

      await sleep(30);

      await this.syncNodeAfterMint();

      return data;
    } catch (error: unknown) {
      throw new Error(
        "Something went wrong with minting your access key, please try again. " +
          error
      );
    }
  }

  private async signAndSendTransaction(
    txData: any
  ): Promise<string | undefined> {
    const feePayer = (this.sdk.solana.provider?.wallet as KeyWallet).payer;
    const recoveredTransaction = await getRawTransaction(
      Uint8Array.from(Object.values(txData))
    );

    if (recoveredTransaction instanceof VersionedTransaction) {
      recoveredTransaction.sign([feePayer]);
    } else {
      recoveredTransaction.partialSign(feePayer);
    }

    const txnSignature = await this.sdk.solana.connection?.sendRawTransaction(
      recoveredTransaction.serialize()
    );

    return txnSignature;
  }

  private async confirmTransaction(
    txnSignature: string | undefined
  ): Promise<void> {
    const latestBlockHash =
      await this.sdk.solana.connection?.getLatestBlockhash();
    if (latestBlockHash && txnSignature) {
      const confirmStrategy: BlockheightBasedTransactionConfirmationStrategy = {
        blockhash: latestBlockHash.blockhash,
        lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
        signature: txnSignature,
      };
      await this.sdk.solana.connection?.confirmTransaction(confirmStrategy);
    } else {
      throw new Error("Could not confirm minting transaction");
    }
  }

  private async syncNodeAfterMint(): Promise<any> {
    try {
      const { data, error } = await clientSelector({ withAuth: true }).POST(
        // @ts-expect-error: route not yet in OpenAPI schema
        "/api/nodes/sync-node",
        {
          body: { address: this.address.toString() },
        }
      );
      return data ?? error;
    } catch (error) {
      throw error;
    }
  }
}
