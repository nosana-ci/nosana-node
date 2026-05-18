import { FlowState, Job, Run, Client as SDK } from '@nosana/sdk';
import { ipfsHashToSolBytesArray } from '@nosana/ipfs';
import chalk from 'chalk';
import { NodeRepository } from '../../repository/NodeRepository.js';
import { JobExternalUtil } from './jobExternalUtil.js';
import { IpfsClientSingleton } from '../../../ipfs/IpfsClient.js';

export class JobRegistry {
  private static instance: JobRegistry;
  private registry = new Map<string, Job>();
  private runs = new Map<string, Run>();

  private constructor() {}

  public static getInstance(): JobRegistry {
    if (!JobRegistry.instance) {
      JobRegistry.instance = new JobRegistry();
    }
    return JobRegistry.instance;
  }

  public register(jobId: string, run: Run, job: Job) {
    this.registry.set(jobId, job);
    this.runs.set(jobId, run);
  }

  public get(jobId: string): Job | undefined {
    return this.registry.get(jobId);
  }

  public remove(jobId: string) {
    this.registry.delete(jobId);
    this.runs.delete(jobId);
  }

  public has(jobId: string): boolean {
    return this.registry.has(jobId);
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  private isStaleCleanupError(error: unknown): boolean {
    const message = this.getErrorMessage(error);

    return (
      message.includes('AccountNotInitialized') ||
      message.includes('The program expected this account to be already initialized') ||
      message.includes('Account does not exist or has no data')
    );
  }

  private logCleanupError(jobId: string, error: unknown): void {
    if (this.isStaleCleanupError(error)) {
      console.warn(
        chalk.yellow(
          `Skipping cleanup result submission for stale job ${jobId}: run is already closed on-chain.`,
        ),
      );
      return;
    }

    console.warn(
      chalk.yellow(
        `Cleanup could not submit result for job ${jobId}: ${this.getErrorMessage(error)}`,
      ),
    );
  }

  public async stop(sdk: SDK, repository: NodeRepository): Promise<void> {
    const stopPromises: Promise<{ jobId: string; error?: unknown }>[] = [];

    for (const [jobId, job] of this.registry.entries()) {
      const promise = (async () => {
        try {
          const jobExternalUtil = new JobExternalUtil(repository);
          const result = await jobExternalUtil.resolveResult(jobId, job);

          const ipfsResult = await IpfsClientSingleton.pin(result as object);
          const bytesArray = ipfsHashToSolBytesArray(ipfsResult);

          await sdk.jobs.submitResult(
            bytesArray,
            this.runs.get(jobId) as Run,
            job.market,
          );
          return { jobId };
        } catch (error) {
          return { jobId, error };
        } finally {
          this.runs.delete(jobId);
          this.registry.delete(jobId);
        }
      })();

      stopPromises.push(promise);
    }

    const results = await Promise.all(stopPromises);
    for (const result of results) {
      if (result.error) {
        this.logCleanupError(result.jobId, result.error);
      }
    }
  }
}
