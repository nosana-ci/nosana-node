import { Readable } from 'stream';
import { createInterface } from 'readline';

import { parseLogFrames } from './utils/parseBuffer.js';
import { parseDockerStat } from './utils/parseDockerStat.js';
import { liveAbortSignal } from '../utils/liveAbortSignal.js';

import type EventEmitter from 'events';
import type Dockerode from 'dockerode';
import type { RestartPolicy } from '@nosana/sdk';
type ContainerState = 'starting' | 'running' | 'exited' | 'restarting';

function destroyStream(stream: NodeJS.ReadableStream | null): void {
  if (!stream) return;
  stream.removeAllListeners();
  if (stream instanceof Readable) {
    stream.destroy();
  }
}

export class ContainerStateManager {
  private state: ContainerState = 'starting';
  private exitedCheckCount: number = 0;
  private lastLogTimestamp: number = 0; // Unix timestamp in seconds from actual container logs
  private logRemainder: Buffer = Buffer.alloc(0); // trailing partial frame between chunks
  private readonly EXITED_CHECKS_REQUIRED = 3; // Require 3 consecutive checks before confirming exit
  private currentLogStream: NodeJS.ReadableStream | null = null;
  private currentStatsStream: NodeJS.ReadableStream | null = null;
  private pollingInterval: NodeJS.Timeout | null = null;

  constructor(
    private container: Dockerode.Container,
    private controller: AbortController,
    private emitter: EventEmitter,
    private restartPolicy: RestartPolicy | undefined,
  ) { }

  getState(): ContainerState {
    return this.state;
  }

  async startMonitoring() {
    await Promise.all([this.attachLogStream(), this.attachStatsStream()]);

    if (!this.restartPolicy) {
      this.container
        .wait({ abortSignal: liveAbortSignal(this.controller.signal) })
        .finally(() => {
          this.state = 'exited';
        })
        .catch(() => {
          // `wait` rejects with an AbortError when the op is aborted (timeout,
          // stop, expiry) while the container is still running. The exit is
          // already reflected via `state` above and observed by `waitForExit`,
          // so swallow the rejection to avoid an unhandled promise rejection.
        });
      return;
    }

    this.pollingInterval = setInterval(async () => {
      if (this.controller.signal.aborted) {
        this.stopMonitoring();
        return;
      }

      try {
        const inspectInfo = await this.container.inspect();
        let inspectedState = inspectInfo.State.Status.toLowerCase();

        if (['running', 'restarting'].includes(inspectedState)) {
          this.exitedCheckCount = 0;
          this.state = inspectedState as ContainerState;
          return;
        }

        this.exitedCheckCount++;
        if (this.exitedCheckCount >= this.EXITED_CHECKS_REQUIRED) {
          this.state = 'exited';
        }
      } catch (error) {
        this.exitedCheckCount++;
        if (this.exitedCheckCount >= this.EXITED_CHECKS_REQUIRED) {
          this.state = 'exited';
          this.stopMonitoring();
        }
      }
    }, 1000);
  }

  private async attachLogStream() {
    // A re-attach can be scheduled (on stream close) before an abort lands;
    // bail if the op is already gone so we never open a stream against a
    // container we're tearing down. Mirrors `attachStatsStream`.
    if (this.controller.signal.aborted) return;

    // Any partial frame buffered from a previous stream can never be completed
    // by this freshly re-attached stream, so start clean.
    this.logRemainder = Buffer.alloc(0);

    try {
      this.currentLogStream = await this.container.logs({
        stdout: true,
        stderr: true,
        follow: true,
        timestamps: true,
        since: this.lastLogTimestamp + 1,
        abortSignal: liveAbortSignal(this.controller.signal),
      });

      this.currentLogStream.on('data', (data: Buffer) => {
        // A single 'data' event can carry several multiplexed frames (Docker
        // coalesces output, especially the final flush at container exit) and
        // can split one frame across events. Decode every complete frame and
        // carry any partial trailing frame over to the next chunk.
        const { logs, rest } = parseLogFrames(
          Buffer.concat([this.logRemainder, data]),
        );
        this.logRemainder = rest;

        for (const { log, type, timestamp } of logs) {
          if (!log) continue;

          this.lastLogTimestamp = Math.floor(
            new Date(timestamp).getTime() / 1000,
          );
          this.emitter.emit('log', log, type, 'container', timestamp);
        }
      });

      this.currentLogStream.on('close', () => {
        this.currentLogStream = null;

        if (this.state === 'running' && !this.controller.signal.aborted) {
          setTimeout(() => this.attachLogStream(), 100);
        }
      });

      // Clean up on abort
      const abortHandler = () => {
        destroyStream(this.currentLogStream);
        this.currentLogStream = null;
      };
      this.controller.signal.addEventListener('abort', abortHandler, {
        once: true,
      });
    } catch (error) {
      if (this.state === 'running' && !this.controller.signal.aborted) {
        setTimeout(() => this.attachLogStream(), 1000);
      }
    }
  }

  async waitForExit(): Promise<void> {
    return new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (this.state === 'exited' || this.controller.signal.aborted) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 500);
    });
  }

  /**
   * Wait for the followed log stream to finish delivering its final buffered
   * frames after the container has exited.
   *
   * `container.wait()` (which drives `waitForExit`) and the log stream are
   * independent connections, so when `wait()` reports the exit the stream may
   * still be flushing the last lines (e.g. an op's final result line). Reading
   * logs or tearing the stream down at that point loses them. The stream's
   * `close` handler nulls `currentLogStream`, and it won't re-attach once the
   * container has exited, so a null stream means the flush is complete. Bounded
   * so a stream that never closes can't stall completion.
   */
  async waitForLogsDrained(timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.currentLogStream !== null) {
      if (this.controller.signal.aborted || Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  stopMonitoring() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    destroyStream(this.currentLogStream);
    this.currentLogStream = null;

    destroyStream(this.currentStatsStream);
    this.currentStatsStream = null;
  }

  private readonly STATS_INTERVAL_MS = 5000;

  private async attachStatsStream() {
    if (this.controller.signal.aborted) return;

    try {
      this.currentStatsStream = await this.container.stats({ stream: true });

      let peakStat: ReturnType<typeof parseDockerStat> = null;

      const rl = createInterface({ input: this.currentStatsStream });
      rl.on('line', (line) => {
        try {
          const raw: Dockerode.ContainerStats = JSON.parse(line);
          const stat = parseDockerStat(raw);
          if (!stat) return;

          if (!peakStat || stat.cpu.cpu_percent > peakStat.cpu.cpu_percent) {
            peakStat = stat;
          }
        } catch { }
      });

      const statsInterval = setInterval(() => {
        if (peakStat) {
          this.emitter.emit('stat', peakStat);
          peakStat = null;
        }
      }, this.STATS_INTERVAL_MS);

      const cleanup = () => {
        clearInterval(statsInterval);
        this.currentStatsStream = null;
      };

      this.currentStatsStream.on('close', cleanup);
      this.currentStatsStream.on('error', cleanup);

      const abortHandler = () => {
        clearInterval(statsInterval);
        destroyStream(this.currentStatsStream);
        this.currentStatsStream = null;
      };
      this.controller.signal.addEventListener('abort', abortHandler, { once: true });
    } catch { }
  }
}
