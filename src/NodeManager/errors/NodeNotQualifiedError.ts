import { getSDK } from '../sdk/index.js';

export class NodeNotQualifiedError extends Error {
  constructor(nextTestAt?: string) {
    const nextTestSuffix = formatNextTestSuffix(nextTestAt);
    const address = getSDK().solana.wallet.publicKey.toString();
    super(
      `Node does not meet the minimum requirements for any market.${nextTestSuffix} For a detailed breakdown of your latest benchmark results, visit https://host.nosana.com/${address}.`,
    );
    this.name = 'NodeNotQualifiedError';
  }
}

function formatNextTestSuffix(nextTestAt?: string): string {
  if (!nextTestAt) return '';
  const next = new Date(nextTestAt);
  if (Number.isNaN(next.getTime()) || next.getTime() <= Date.now()) return '';
  return ` Next eligible retest at ${next.toISOString()}.`;
}
