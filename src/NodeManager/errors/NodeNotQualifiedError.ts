export class NodeNotQualifiedError extends Error {
  constructor(nextTestAt?: string) {
    const nextTestSuffix = formatNextTestSuffix(nextTestAt);
    super(`Node does not meet the minimum requirements for any market.${nextTestSuffix} Shutting down.`);
    this.name = 'NodeNotQualifiedError';
  }
}

function formatNextTestSuffix(nextTestAt?: string): string {
  if (!nextTestAt) return '';
  const next = new Date(nextTestAt);
  if (Number.isNaN(next.getTime()) || next.getTime() <= Date.now()) return '';
  return ` Next eligible retest at ${next.toISOString()}.`;
}
