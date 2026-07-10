import { describe, expect, it, vi } from 'vitest';
import EventEmitter from 'events';
import type { Flow, JobDefinition, Operation, OperationType } from '@nosana/sdk';

import TaskManager from '../TaskManager.js';
import { NodeRepository } from '../../../repository/NodeRepository.js';
import type { Provider } from '../../../provider/Provider.js';

vi.mock('../../../configs/configs.js', () => ({
  configs: () => ({
    frp: {
      serverAddr: 'test.frp.server.com',
      serverPort: 7000,
    },
  }),
}));

vi.mock('../../../configs/NodeConfigs.js', () => ({
  NodeConfigsSingleton: {
    getInstance: vi.fn().mockReturnValue({ options: { isNodeRun: false } }),
  },
}));

vi.mock('../../../sdk/index.js', () => ({
  getSDK: () => ({
    solana: {
      wallet: {
        publicKey: { toString: () => 'test-node-address' },
      },
    },
  }),
}));

const TEST_JOB_ID = 'test-job';
const TEST_PROJECT = 'test-project';

function createJobDefinition(
  ops: JobDefinition['ops'],
): JobDefinition {
  return {
    version: '0.1',
    type: 'container',
    ops,
  } as JobDefinition;
}

function createRunOp(id: string, group?: string): Operation<'container/run'> {
  return {
    type: 'container/run',
    id,
    args: {
      image: 'test-image:latest',
      cmd: 'echo test',
    },
    ...(group ? { execution: { group } } : {}),
  } as Operation<'container/run'>;
}

function createRepository(): NodeRepository {
  const db = {
    data: { flows: {} as Record<string, Flow> },
    write: () => {},
  };
  return new NodeRepository(db as any);
}

/**
 * A provider stub that runs each op through its normal event lifecycle,
 * exiting with the given exit code per op id (default 0), or emitting an
 * 'error' for op ids listed in `erroringOps`.
 */
function createProvider(
  exitCodes: Record<string, number> = {},
  erroringOps: string[] = [],
): Provider {
  return {
    runTaskManagerOperation: vi.fn(
      async (
        _flow: Flow,
        op: Operation<OperationType>,
        _controller: AbortController,
        emitter: EventEmitter,
      ) => {
        emitter.emit('start');
        if (erroringOps.includes(op.id)) {
          emitter.emit('error', new Error('container crashed'));
        } else {
          emitter.emit('exit', { exitCode: exitCodes[op.id] ?? 0 });
        }
        emitter.emit('end');
      },
    ),
    stopTaskManagerOperation: vi.fn(async () => {}),
  } as unknown as Provider;
}

async function runJob(
  provider: Provider,
  ops: JobDefinition['ops'],
): Promise<NodeRepository> {
  const repository = createRepository();
  const manager = new TaskManager(
    provider,
    repository,
    TEST_JOB_ID,
    TEST_PROJECT,
    createJobDefinition(ops),
  );
  manager.bootstrap();
  await manager.start();
  return repository;
}

describe('TaskManager', () => {
  describe('final flow status', () => {
    it('marks the flow as success when all ops exit with code 0', async () => {
      const repository = await runJob(createProvider(), [
        createRunOp('op-1'),
        createRunOp('op-2'),
      ]);

      const state = repository.getFlowState(TEST_JOB_ID);
      expect(state.opStates.map((op) => op.status)).toEqual([
        'success',
        'success',
      ]);
      expect(state.status).toEqual('success');
    });

    it('marks the flow as failed when any op exits with a non-zero code', async () => {
      const repository = await runJob(createProvider({ 'op-2': 1 }), [
        createRunOp('op-1'),
        createRunOp('op-2'),
        createRunOp('op-3'),
      ]);

      const state = repository.getFlowState(TEST_JOB_ID);
      expect(state.opStates.map((op) => op.status)).toEqual([
        'success',
        'failed',
        'success',
      ]);
      expect(state.status).toEqual('failed');
    });

    it('marks the flow as failed when any parallel op in a group fails', async () => {
      const repository = await runJob(createProvider({ 'op-2': 137 }), [
        createRunOp('op-1', 'group-1'),
        createRunOp('op-2', 'group-1'),
      ]);

      const state = repository.getFlowState(TEST_JOB_ID);
      expect(state.status).toEqual('failed');
    });

    it('marks the flow as failed when an op errors during execution', async () => {
      const repository = await runJob(createProvider({}, ['op-1']), [
        createRunOp('op-1'),
      ]);

      const state = repository.getFlowState(TEST_JOB_ID);
      expect(state.opStates[0].status).toEqual('failed');
      expect(state.status).toEqual('failed');
    });
  });
});
