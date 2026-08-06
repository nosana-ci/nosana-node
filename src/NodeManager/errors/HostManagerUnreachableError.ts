export class HostManagerUnreachableError extends Error {
  // Redeclared because the ES2021 lib typings predate Error.cause.
  public readonly cause: unknown;

  constructor(attempts: number, cause: unknown) {
    super(
      `Could not reach the host manager after ${attempts} attempts: ${describeNetworkError(cause)}. Check your internet connection and firewall, then restart the node.`,
    );
    this.name = 'HostManagerUnreachableError';
    this.cause = cause;
  }
}

/**
 * Undici reports every network failure as `TypeError: fetch failed` and hides
 * the actual reason (ECONNRESET, EAI_AGAIN, ...) in the error's cause chain,
 * so surface it in the message.
 */
export function describeNetworkError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof AggregateError && cause.errors.length > 0) {
    return `${error.message} (${cause.errors.map(describeSingle).join('; ')})`;
  }
  if (cause instanceof Error) {
    return `${error.message} (${describeSingle(cause)})`;
  }
  return describeSingle(error);
}

function describeSingle(error: Error): string {
  const code = (error as NodeJS.ErrnoException).code;
  return code && !error.message.includes(code)
    ? `${code}: ${error.message}`
    : error.message;
}
