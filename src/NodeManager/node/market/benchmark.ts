import chalk from 'chalk';
import { Client, ContainerRunArgs, JobDefinition } from "@nosana/sdk";

import { HostManager } from './hostManager.js';
import TaskManager, { OperationProgressStatuses } from "../task/TaskManager.js";
import { Provider } from "../../provider/Provider.js";
import { NodeRepository } from "../../repository/NodeRepository.js";
import { createLoggingProxy, logEmitter } from '../../monitoring/proxy/loggingProxy.js';

interface Metric {
  metric: string,
  metric_name: string,
  thresholdValue?: string,
  measuredValue?: number,
  passed: boolean,
  feedbackMessage?: string,
  benchmarkId?: number,
  submittedAt?: Date
}

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
    const results = await this.submitResults();
    await this.reportResults(results);
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

  private async submitResults(): Promise<Metric[]> {
    const flowResults = this.repository.getFlow(this.benchmarkId);
    if (!flowResults) throw new Error(`Cannot find results for flow with id ${this.benchmarkId}`);

    this.repository.deleteflow(this.benchmarkId);

    const response = await HostManager.submitBenchmarkResults(this.benchmarkId, flowResults.state);

    return (response.report?.metrics ?? []).map(m => ({
      metric: m.metricKey,
      metric_name: m.metricKey,
      thresholdValue: typeof m.value === 'string' || typeof m.value === 'number' ? String(m.value) : undefined,
      measuredValue: typeof m.measuredValue === 'number' ? m.measuredValue : undefined,
      passed: m.passed,
      feedbackMessage: m.failureMessage,
    }));
  }

  private reportResults(metrics: Metric[]): void {
    const passed = metrics.filter(m => m.passed).length;
    const failed = metrics.length - passed;
    const nameWidth = metrics.length > 0
      ? Math.max(20, ...metrics.map(m => m.metric_name.length))
      : 20;
    const width = nameWidth + 20;

    console.log();
    console.log('  ' + chalk.cyan('━'.repeat(width)));
    console.log('  ' + chalk.bold.cyan('BENCHMARK RESULTS'));
    console.log('  ' + chalk.cyan('━'.repeat(width)));
    console.log();

    for (const metric of metrics) {
      this.reportMetric(metric, nameWidth);
    }

    console.log();
    console.log('  ' + chalk.gray('─'.repeat(width)));

    const parts = [chalk.green(`✔ ${passed} passed`)];
    if (failed > 0) parts.push(chalk.red(`✖ ${failed} failed`));
    parts.push(chalk.gray(`${metrics.length} total`));
    console.log('  ' + parts.join(chalk.gray('  •  ')));

    console.log('  ' + chalk.gray('─'.repeat(width)));
    console.log();

    if (failed > 0) {
      console.log(chalk.yellow('  ⚠ Some benchmarks failed. The Host Manager will evaluate eligibility on the next request.'));
      console.log();
    }
  }

  private reportMetric(metric: Metric, nameWidth: number): void {
    const icon = metric.passed ? chalk.green('✔') : chalk.red('✖');
    const name = chalk.bold(metric.metric_name.padEnd(nameWidth));
    const value = metric.measuredValue !== undefined && metric.thresholdValue
      ? chalk.gray(`${metric.measuredValue} / ${metric.thresholdValue}`)
      : '';

    console.log(`  ${icon}  ${name}  ${value}`);

    if (!metric.passed && metric.feedbackMessage) {
      console.log(chalk.yellow(`     ↳ ${metric.feedbackMessage}`));
    }
  }
}