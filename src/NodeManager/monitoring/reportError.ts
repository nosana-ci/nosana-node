import { getSDK } from '../sdk/index.js';
import { HostManager } from '../node/market/hostManager.js';

export type NodeErrorReport = {
  error_type: string;
  error_name: string;
  error_message: string;
  error_stack: string;
};

/**
 * Send an error to the host, so it is visible off the node.
 *
 * Never throws or rejects: callers are already handling a failure, some from
 * signal handlers where a rejection would be the only trace left.
 */
export async function reportError(report: NodeErrorReport): Promise<void> {
  try {
    const nosana = getSDK();

    await HostManager.reportError({
      address: nosana.solana.provider!.wallet.publicKey.toString(),
      ...report,
    });
  } catch {
    // Best effort: an unreachable host must not mask the original failure.
  }
}
