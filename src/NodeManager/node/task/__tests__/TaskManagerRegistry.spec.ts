import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaskManagerRegistry } from '../TaskManagerRegistry.js';

function fakeManager(group: string | undefined, statuses: Record<string, string>) {
  return {
    getCurrentGroup: () => group,
    getCurrentGroupStatus: () => statuses,
    restartTaskManagerOperation: vi.fn(async () => {}),
  } as any;
}

describe('TaskManagerRegistry.restartRunningOperations', () => {
  const registry = TaskManagerRegistry.getInstance();

  afterEach(() => {
    for (const id of ['job-a', 'job-b']) registry.remove(id);
  });

  it('restarts only the running operations of the current group, in every job', () => {
    const a = fakeManager('group-1', {
      done: 'finished',
      serving: 'running',
      later: 'pending',
      busy: 'restarting',
    });
    const b = fakeManager('group-2', { worker: 'running' });
    registry.register('job-a', a);
    registry.register('job-b', b);

    registry.restartRunningOperations();

    expect(a.restartTaskManagerOperation.mock.calls).toEqual([
      ['group-1', 'serving'],
    ]);
    expect(b.restartTaskManagerOperation.mock.calls).toEqual([
      ['group-2', 'worker'],
    ]);
  });

  it('leaves a job that has no active group alone', () => {
    const a = fakeManager(undefined, { op: 'running' });
    registry.register('job-a', a);

    registry.restartRunningOperations();

    expect(a.restartTaskManagerOperation).not.toHaveBeenCalled();
  });
});
