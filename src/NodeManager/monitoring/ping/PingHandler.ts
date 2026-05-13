import { clientSelector } from "../../client/index.js";

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

  async start() {
    if (this.timeoutId) return;

    // start with an immediate ping
    await this.scheduleNextPing(Date.now());
  }

  private async scheduleNextPing(expectedTime: number) {
    await this.ping();

    const nextExpected = expectedTime + this.intervalSeconds * 1000;

    const delay = Math.max(nextExpected - Date.now(), 0);
    this.timeoutId = setTimeout(() => {
      this.scheduleNextPing(nextExpected);
    }, delay);
  }

  private async ping() {
    try {
      const { data, response } = await clientSelector({ withAuth: true }).POST(
        // @ts-expect-error: route not yet in OpenAPI schema
        "/api/nodes/heartbeat",
        {
          body: { ping: "pong" },
        }
      );

      if (response.ok && data) {
        const json = data as { maxHeartbeatsPerDay?: number };

        if (json.maxHeartbeatsPerDay) {
          const newInterval = Math.floor(
            (24 * 60 * 60) / json.maxHeartbeatsPerDay
          );

          if (newInterval !== this.intervalSeconds) {
            this.intervalSeconds = newInterval;
          }
        }
      }
    } catch (err) {
      console.error("Ping failed:", err);
    }
  }

  stop() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }
}
