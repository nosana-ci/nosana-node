import chalk from 'chalk';
import { Client, ContainerRunArgs, JobDefinition } from "@nosana/sdk";

import { HostManager } from './hostManager.js';
import TaskManager, { OperationProgressStatuses } from "../task/TaskManager.js";
import { Provider } from "../../provider/Provider.js";
import { NodeRepository } from "../../repository/NodeRepository.js";
import { createLoggingProxy, logEmitter } from '../../monitoring/proxy/loggingProxy.js';

export class Benchmark {
  constructor(
    private benchmarkId: string,
    private jobDefinition: JobDefinition,
    private sdk: Client,
    private provider: Provider,
    private repository: NodeRepository,
  ) { }

  public async run(): Promise<void> {
    await this.executeBenchmark();
    await this.submitResults();
    await this.reportResults();
  }

  private async executeBenchmark(): Promise<void> {
    for (const op of this.jobDefinition.ops) {
      if (op.type === "container/run") {
        (op.args as ContainerRunArgs).env = {
          ...((op.args as ContainerRunArgs).env || {}),
          authorization: await this.sdk.authorization.generate(
            this.sdk.solana.provider!.wallet.publicKey.toString()
          ),
        };
      }
    }

    const task = createLoggingProxy(
      new TaskManager(
        this.provider,
        this.repository,
        this.benchmarkId,
        this.sdk.solana.wallet.publicKey.toString(),
        this.jobDefinition,
      ),
      'BenchmarkTaskManager',
    );

    const total = this.jobDefinition.ops.length;
    const events = task.getEventsEmitter();

    const onUpdate = () => {
      // Defer so we read status after the FINISHED setter (which runs
      // after the relay listener that fires this event).
      queueMicrotask(() => {
        const statuses = task.getOperationsStatus();
        const completed = Object.values(statuses).filter(
          (s) => s === OperationProgressStatuses.FINISHED,
        ).length;
        logEmitter.emit('log', {
          class: 'BenchmarkTaskManager',
          method: 'progress',
          arguments: [],
          timestamp: new Date().toISOString(),
          type: 'call',
          payload: { completed, total },
        });
      });
    };

    events.on('flow:updated', onUpdate);

    try {
      task.bootstrap();
      await task.start();
    } catch (error) {
      console.error('Error executing benchmark:', error);
    } finally {
      events.off('flow:updated', onUpdate);
    }
  }

  private async submitResults(): Promise<void> {
    const flowResults = this.repository.getFlow(this.benchmarkId);
    if (!flowResults) throw new Error(`Cannot find results for flow with id ${this.benchmarkId}`);

    this.repository.deleteflow(this.benchmarkId);

    await HostManager.submitBenchmarkResults(this.benchmarkId, flowResults.state);
  }

  private async reportResults(): Promise<void> {
    const address = this.sdk.solana.provider!.wallet.publicKey.toString();

    let response;
    try {
      response = await HostManager.getNodeMetrics(address);
    } catch (error) {
      console.warn(chalk.yellow('Could not fetch latest measurements:'), error);
      return;
    }

    const rawMetrics = response?.metrics as Record<string, unknown> | undefined;
    if (!rawMetrics) return;

    const flat = flattenMetrics(rawMetrics);
    if (flat.length === 0) return;

    const nameWidth = Math.max(20, ...flat.map(([key]) => key.length));
    const width = nameWidth + 30;

    console.log();
    console.log('  ' + chalk.cyan('━'.repeat(width)));
    console.log('  ' + chalk.bold.cyan('LATEST MEASUREMENTS'));
    console.log('  ' + chalk.cyan('━'.repeat(width)));
    console.log();

    for (const [key, value] of flat) {
      const name = chalk.bold(key.padEnd(nameWidth));
      const details = chalk.cyan(`measured: ${value}`);
      console.log(`  ${chalk.cyan('•')}  ${name}  ${details}`);
    }

    console.log();
  }
}

function flattenMetrics(
  obj: Record<string, unknown>,
  prefix = '',
): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        const indexed = `${fullKey}[${i}]`;
        if (item && typeof item === 'object') {
          result.push(...flattenMetrics(item as Record<string, unknown>, indexed));
        } else {
          result.push([indexed, String(item)]);
        }
      });
    } else if (value && typeof value === 'object') {
      result.push(...flattenMetrics(value as Record<string, unknown>, fullKey));
    } else if (value !== null && value !== undefined) {
      result.push([fullKey, String(value)]);
    }
  }
  return result;
}