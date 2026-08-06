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

    await HostManager.submitBenchmarkResults(this.benchmarkId, flowResults.state);

    this.repository.deleteflow(this.benchmarkId);
  }
}