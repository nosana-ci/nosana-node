import {
  ExposedPort,
  HealthCheck,
  HttpHealthCheck,
  WebSocketHealthCheck,
} from '@nosana/sdk';
import Dockerode from 'dockerode';
import EventEmitter from 'events';

/**
 * `restart_on_failure` and `max_restarts` ship in the @nosana/sdk release that
 * accompanies this change; widening the SDK type here keeps the node building
 * against an SDK that predates them.
 */
export type RestartableHealthCheck = HealthCheck & {
  restart_on_failure?: boolean;
  max_restarts?: number;
};

/**
 * `null` from a health check means no check ran at all, which is distinct from
 * a check that ran and failed — only the latter says anything about the service.
 */
type PortHealth = { healthy: boolean; failedCheck?: RestartableHealthCheck };

export class ExposedPortHealthCheck {
  private exposedPortMap: Map<string, ExposedPort> = new Map();
  private frpcContainer: Dockerode.Container;
  private containerName: string;
  private startupIntervalMs: number;
  private continuousIntervalMs: number;
  /**
   * Tracks job previous state to show change in state of job mainly when going from failed to success.
   */
  private healthStatus: Map<string, boolean> = new Map();
  private jobEmitter: EventEmitter;
  private intervals: Map<string, NodeJS.Timeout> = new Map();
  /**
   * Restarts the container in place. Set only when an exposed port declares a
   * `restart_on_failure` check; without it a failure is reported and no more.
   */
  private restartContainer?: () => Promise<boolean>;
  /** Health-triggered restarts so far, counted across every exposed port. */
  private restartCount = 0;
  private restartInFlight = false;
  private restartLimitLogged = false;
  private stopped = false;

  // Every curl is bounded: an unbounded one holds the startup check open and
  // nothing waiting on the service ever starts. The startup budget is generous
  // because a health check can be a real request against a model that is still
  // loading, and checks there never overlap. The continuous budget stays under
  // the interval it runs on, where nothing serialises them.
  private readonly connectTimeoutSeconds = 2;
  private readonly startupMaxTimeSeconds = 60;
  private readonly continuousMaxTimeSeconds = 20;

  private flowId: string;

  constructor(
    flowId: string,
    frpcContainer: Dockerode.Container,
    jobEmitter: EventEmitter,
    containerName: string,
    restartContainer?: () => Promise<boolean>,
    startupIntervalMs = 5000,
    continuousIntervalMs = 30000,
  ) {
    this.flowId = flowId;
    this.frpcContainer = frpcContainer;
    this.jobEmitter = jobEmitter;
    this.containerName = containerName;
    this.restartContainer = restartContainer;
    this.startupIntervalMs = startupIntervalMs;
    this.continuousIntervalMs = continuousIntervalMs;
  }

  addExposedPortsMap(exposedPortMap: Map<string, ExposedPort>) {
    this.exposedPortMap = exposedPortMap;
    this.reportUnreachableRestartChecks();
  }

  /**
   * A continuous pass only covers checks up to the first non-continuous one, so
   * a liveness probe that isn't continuous, or that sits behind a startup-only
   * check, never runs. Say so rather than let `restart_on_failure` look active
   * while doing nothing.
   */
  private reportUnreachableRestartChecks() {
    for (const [id, exposedPort] of this.exposedPortMap) {
      const checks = (exposedPort.health_checks ??
        []) as RestartableHealthCheck[];
      const startupOnly = checks.findIndex((check) => !check.continuous);

      checks.forEach((check, index) => {
        if (!check.restart_on_failure) return;
        if (check.continuous && (startupOnly === -1 || index < startupOnly)) {
          return;
        }

        this.jobEmitter.emit(
          'log',
          `restart_on_failure on ${id} is never reached: a liveness check has to be continuous and declared before any check that is not`,
          'info',
        );
      });
    }
  }

  startServiceExposedUrlHealthCheck() {
    for (const [id, exposedPort] of this.exposedPortMap) {
      this.startStartupHealthCheck(id, exposedPort);
    }
  }

  private startStartupHealthCheck(id: string, exposedPort: ExposedPort) {
    let startupCheckInterval: NodeJS.Timeout | null = null;
    let checkInFlight = false;

    startupCheckInterval = setInterval(async () => {
      // Two checks in flight both report the service up.
      if (checkInFlight) return;
      checkInFlight = true;

      const result = await this.checkPortHealth(exposedPort, true).finally(
        () => {
          checkInFlight = false;
        },
      );

      if (result == null) {
        clearInterval(startupCheckInterval!);
        this.jobEmitter.emit('healthcheck:url:exposed', {
          id,
          flowId: this.flowId,
          port: exposedPort.port,
          service: exposedPort.type,
        });
        return;
      }

      if (result.healthy) {
        clearInterval(startupCheckInterval!);

        // Seed the tracked state, so the *first* continuous failure reads as a
        // change. Left unset it defaults to unhealthy, and a service that goes
        // down and stays down never reports a transition at all.
        this.healthStatus.set(id, true);

        this.jobEmitter.emit('healthcheck:startup:success', {
          id,
          flowId: this.flowId,
          port: exposedPort.port,
          service: exposedPort.type,
        });

        // **Start continuous health check only after startup success**
        this.startContinuousHealthCheck(id, exposedPort);
      }
    }, this.startupIntervalMs);

    // Store the interval so we can stop it later
    this.intervals.set(id, startupCheckInterval);
  }

  private startContinuousHealthCheck(id: string, exposedPort: ExposedPort) {
    let continuousCheckInterval = setInterval(async () => {
      const result = await this.checkPortHealth(exposedPort, false);

      if (result === null) {
        clearInterval(continuousCheckInterval!);
        return; // Skip logging or emitting events if no check was done.
      }

      const previousState = this.healthStatus.get(id) || false;

      if (result.healthy !== previousState) {
        this.healthStatus.set(id, result.healthy);
        if (!result.healthy) {
          this.jobEmitter.emit('healthcheck:continuous:failure', {
            id,
            flowId: this.flowId,
            port: exposedPort.port,
            service: exposedPort.type,
          });
        }
      }

      // A continuous check only ever runs once the service has passed startup,
      // so reaching here unhealthy is the liveness case: it worked, then stopped.
      if (!result.healthy && result.failedCheck?.restart_on_failure) {
        await this.restartUnhealthyContainer(id, result.failedCheck);
      }
    }, this.continuousIntervalMs);

    this.intervals.set(id, continuousCheckInterval);
  }

  /**
   * Restart the container behind a failed liveness probe.
   *
   * The restart is container-wide even though the probe belongs to one port, so
   * every port drops back to startup probing and reports itself online again as
   * it starts answering — the same path a first start takes.
   */
  private async restartUnhealthyContainer(
    id: string,
    failedCheck: RestartableHealthCheck,
  ) {
    if (!this.restartContainer || this.restartInFlight || this.stopped) return;

    const maxRestarts = failedCheck.max_restarts;
    if (maxRestarts !== undefined && this.restartCount >= maxRestarts) {
      // The probe keeps running on its interval; say this once rather than
      // every time it comes back unhealthy.
      if (!this.restartLimitLogged) {
        this.restartLimitLogged = true;
        this.jobEmitter.emit(
          'log',
          `Health check for ${id} failed but its restart limit (${maxRestarts}) is reached, leaving the container alone`,
          'info',
        );
      }
      return;
    }

    this.restartInFlight = true;
    this.restartCount++;

    // Every port on this container is about to fail for the same reason, so
    // drop all the probes rather than let them race the restart.
    this.intervals.forEach((interval) => clearInterval(interval));
    this.intervals.clear();
    this.healthStatus.clear();

    this.jobEmitter.emit(
      'log',
      `Health check for ${id} failed, restarting container (restart ${this.restartCount}${
        maxRestarts !== undefined ? `/${maxRestarts}` : ''
      })`,
      'info',
    );

    const restarted = await this.restartContainer().catch(() => false);
    this.restartInFlight = false;

    if (!restarted) {
      this.jobEmitter.emit(
        'log',
        'Restarting the container after a failed health check did not succeed',
        'error',
      );
      return;
    }

    // The op can be torn down while the restart is in flight; re-arming then
    // would leave probes running against a container that is going away.
    if (this.stopped) return;

    this.startServiceExposedUrlHealthCheck();
  }

  public stopHealthCheckForId(id: string) {
    if (this.intervals.has(id)) {
      clearInterval(this.intervals.get(id)!);
      this.intervals.delete(id);
      this.healthStatus.delete(id);
      this.exposedPortMap.delete(id);
    }
  }

  public stopAllHealthChecks() {
    this.stopped = true;
    this.intervals.forEach((interval, id) => {
      clearInterval(interval);
    });
    this.intervals.clear();
    this.healthStatus.clear();
    this.exposedPortMap.clear();
  }

  private async checkPortHealth(
    exposedPort: ExposedPort,
    initialRun: boolean,
  ): Promise<PortHealth | null> {
    if (!exposedPort.health_checks || exposedPort.health_checks.length === 0) {
      return null; // Return null to indicate no check was done.
    }

    const maxTimeSeconds = initialRun
      ? this.startupMaxTimeSeconds
      : this.continuousMaxTimeSeconds;

    for (const healthCheck of exposedPort.health_checks as RestartableHealthCheck[]) {
      if (!initialRun && !healthCheck.continuous) {
        return null;
      }
      if (healthCheck.type === 'http' && typeof exposedPort.port === 'number') {
        const success = await this.runHttpHealthCheck(
          exposedPort.port,
          healthCheck,
          maxTimeSeconds,
        );
        if (!success) return { healthy: false, failedCheck: healthCheck };
      } else if (
        healthCheck.type === 'websocket' &&
        typeof exposedPort.port === 'number'
      ) {
        const success = await this.runWebSocketHealthCheck(
          exposedPort.port,
          healthCheck,
          maxTimeSeconds,
        );
        if (!success) return { healthy: false, failedCheck: healthCheck };
      }
    }

    return { healthy: true };
  }

  private async runHttpHealthCheck(
    port: number,
    healthCheck: HttpHealthCheck,
    maxTimeSeconds: number,
  ): Promise<boolean> {
    const url = `http://${this.containerName}:${port}${healthCheck.path}`;
    const cmd: string[] = [
      'curl',
      '-s',
      '--connect-timeout',
      String(this.connectTimeoutSeconds),
      '--max-time',
      String(maxTimeSeconds),
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      '-X',
      healthCheck.method,
      url,
    ];

    if (healthCheck.headers) {
      for (const [key, value] of Object.entries(healthCheck.headers)) {
        cmd.push('-H', `${key}: ${value}`);
      }
    }

    if (healthCheck.body && ['POST', 'PUT'].includes(healthCheck.method)) {
      const bodyString =
        typeof healthCheck.body === 'string'
          ? healthCheck.body
          : JSON.stringify(healthCheck.body);
      cmd.push('--data', bodyString);
    }

    try {
      const output = await this.execCommand(cmd);
      return (
        Buffer.from(output, 'utf-8')
          .toString()
          .replace(/[^\x20-\x7E]/g, '')
          .trim() == healthCheck.expected_status.toString()
      );
    } catch (error) {
      return false;
    }
  }

  private async runWebSocketHealthCheck(
    port: number,
    healthCheck: WebSocketHealthCheck,
    maxTimeSeconds: number,
  ): Promise<boolean> {
    const cmd = [
      'curl',
      '--include',
      '--no-buffer',
      '--connect-timeout',
      String(this.connectTimeoutSeconds),
      '--max-time',
      String(maxTimeSeconds),
      `ws://localhost:${port}`,
    ];

    try {
      const output = await this.execCommand(cmd);
      return output.includes(healthCheck.expected_response);
    } catch (error) {
      return false;
    }
  }

  private async execCommand(cmd: string[]): Promise<string> {
    try {
      const exec = await this.frpcContainer.exec({
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true,
      });

      const stream = await exec.start({ hijack: true, stdin: true });

      return new Promise((resolve, reject) => {
        let output = '';

        stream.on('data', (chunk) => {
          output += chunk.toString();
        });

        stream.on('end', () => {
          resolve(output);
        });

        stream.on('error', (err) => {
          reject(err);
        });
      });
    } catch (error) {
      throw new Error(`Exec failed: ${error}`);
    }
  }
}
