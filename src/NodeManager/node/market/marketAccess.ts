import { KeyWallet, Client as SDK } from '@nosana/sdk';
import {
  BlockheightBasedTransactionConfirmationStrategy,
  VersionedTransaction,
} from '@solana/web3.js';
import { getRawTransaction } from '../../sdk/index.js';


export class MarketAccessHandler {

  constructor(private sdk: SDK) {
    
  }


  public async mintAccessKey(sftTxBase64: string): Promise<string> {
    // Incase of blockheight exceeded error, retry 3 times
    for (let i = 0; i < 3; i++) {
      try {
        const txnSignature = await this.signAndSendTransaction(sftTxBase64);
        await this.confirmTransaction(txnSignature);
        return txnSignature as string;
      } catch (error: any) {
        if (
          i === 2 ||
          !error?.message.includes("TransactionExpiredBlockheightExceededError")
        ) {
          throw error;
        }
      }
    }
  }

  private async signAndSendTransaction(
    txData: any,
  ): Promise<string | undefined> {
    const feePayer = (this.sdk.solana.provider?.wallet as KeyWallet).payer;
    const recoveredTransaction = await getRawTransaction(
      Uint8Array.from(Object.values(txData)),
    );

    if (recoveredTransaction instanceof VersionedTransaction) {
      recoveredTransaction.sign([feePayer]);
    } else {
      recoveredTransaction.partialSign(feePayer);
    }

    const txnSignature = await this.sdk.solana.connection?.sendRawTransaction(
      recoveredTransaction.serialize(),
    );

    return txnSignature as string;
  }

  private async confirmTransaction(
    txnSignature: string | undefined,
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
}
