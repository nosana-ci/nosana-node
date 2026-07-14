import { getSDK } from '../sdk/index.js';

export class NodeNotQualifiedError extends Error {
  public readonly nextTestAt?: Date;

  constructor(nextTestAt?: string) {
    const next = parseFutureDate(nextTestAt);
    const nextTestSuffix = next
      ? ` Next eligible retest at ${next.toISOString()}.`
      : '';
    const address = getSDK().solana.wallet.publicKey.toString();
    super(
      `Node does not meet the minimum requirements for any market.${nextTestSuffix} For a detailed breakdown of your latest benchmark results, visit https://host.nosana.com/${address}.`,
    );
    this.name = 'NodeNotQualifiedError';
    this.nextTestAt = next;
  }
}

function parseFutureDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
    return undefined;
  }
  return date;
}
