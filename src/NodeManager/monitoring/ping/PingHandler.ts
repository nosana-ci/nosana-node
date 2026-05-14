import { HostManager } from '../../node/market/hostManager.js';

export const ping = (() => {
  let instance: PingHandler | null = null;

  return async () => {
    if (!instance) {
      instance = new PingHandler();
    }
    await instance.start();
    return instance;
  };
})();

export class PingHandler {
  private timeoutId: NodeJS.Timeout | null = null;
  private intervalSeconds = 30;
  private stopped = false;

  async start() {
    if (this.timeoutId) return;
    this.stopped = false;
    await this.scheduleNextPing(Date.now());
  }

  private async scheduleNextPing(expectedTime: number) {
    const { retryAfterSeconds } = await this.ping();
    if (this.stopped) return;

    const intervalSeconds = retryAfterSeconds ?? this.intervalSeconds;
    const nextExpected = expectedTime + intervalSeconds * 1000;
    const delay = Math.max(nextExpected - Date.now(), 0);
    this.timeoutId = setTimeout(() => {
      this.scheduleNextPing(nextExpected);
    }, delay);
  }

  private async ping(): Promise<{ retryAfterSeconds?: number }> {
    try {
      const response = await HostManager.sendHeartbeat();
      if (response.maxHeartbeatsPerDay) {
        this.intervalSeconds = Math.floor((24 * 60 * 60) / response.maxHeartbeatsPerDay);
      }
      return {};
    } catch (err) {
      const retryAfterSeconds = this.getHeartbeatRetryAfterSeconds(err);
      if (retryAfterSeconds !== null) {
        return { retryAfterSeconds };
      }
      console.error('Ping failed:', err);
      return {};
    }
  }

  private getHeartbeatRetryAfterSeconds(err: unknown): number | null {
    if (!(err instanceof Error)) return null;

    const match = err.message.match(/next heartbeat in (\d+) seconds/i);
    if (!match) return null;

    const retryAfterSeconds = Number.parseInt(match[1], 10);
    return Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds
      : null;
  }

  stop() {
    this.stopped = true;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }
}
