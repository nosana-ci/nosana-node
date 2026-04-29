import chalk from 'chalk';
import { Client, JobDefinition } from "@nosana/sdk";

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
    console.log(chalk.blue(`Benchmark metrics: ${JSON.stringify(results)}`));
    await this.reportResults(results);
  }

  private async executeBenchmark(): Promise<void> {
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

    console.log(chalk.blue(`Submitting benchmark results for benchmark ID ${this.benchmarkId} with flow state: ${JSON.stringify(flowResults)}`));

    const response = await HostManager.submitBenchmarkResults(this.benchmarkId, flowResults.state);
    console.log(chalk.blue(`Benchmark submission response: ${JSON.stringify(response)}`));
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
    const passed = metrics.filter(m => m.passed);
    const failed = metrics.filter(m => !m.passed);

    console.log(
      '\n' + chalk.bgCyan.black.bold('  BENCHMARK RESULTS  ') + '\n'
    );

    for (const metric of metrics) {
      if (metric.passed) {
        this.reportSuccessfulMetric(metric);
      } else {
        this.reportFailedMetric(metric);
      }
    }

    console.log('');

    if (failed.length > 0) {
      console.log(
        chalk.bgRed.white.bold(`  ${failed.length}/${metrics.length} benchmark(s) failed  `)
      );
      console.log(
        chalk.red('\nSome benchmarks failed. The Host Manager will evaluate eligibility on the next request.\n')
      );
    }

    console.log(
      chalk.bgGreen.black.bold(`  ${passed.length}/${metrics.length} benchmark(s) passed  `) + '\n'
    );
  }

  private reportSuccessfulMetric(metric: Metric): void {
    const threshold = metric.measuredValue !== undefined && metric.thresholdValue
      ? chalk.gray(` (${metric.measuredValue} / ${metric.thresholdValue})`)
      : '';

    console.log(chalk.green('  ✔ ') + chalk.bold(metric.metric_name) + threshold);
  }

  private reportFailedMetric(metric: Metric): void {
    const threshold = metric.measuredValue !== undefined && metric.thresholdValue
      ? chalk.gray(` (${metric.measuredValue} / ${metric.thresholdValue})`)
      : '';

    console.log(chalk.red('  ✖ ') + chalk.bold(metric.metric_name) + threshold);

    if (metric.feedbackMessage) {
      console.log(chalk.yellow(`    ↳ ${metric.feedbackMessage}`));
    }
  }
}