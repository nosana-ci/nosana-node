import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskManagerRegistry } from '../../../../task/TaskManagerRegistry.js';
import { wssTaskManagerLogRoute } from '../log.js';

describe('wssTaskManagerLogRoute', () => {
  const task = {
    subscribe: vi.fn(),
    getAllLogs: vi.fn(() => []),
    getLogsByOp: vi.fn(() => []),
    getLogsByGroup: vi.fn(() => []),
  };
  const ws = {
    readyState: WebSocket.OPEN,
    close: vi.fn(),
    send: vi.fn(),
  } as any;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('waits for a starting job to register before subscribing', async () => {
    const get = vi
      .spyOn(TaskManagerRegistry.getInstance(), 'get')
      .mockReturnValueOnce(undefined)
      .mockReturnValue(task as any);

    const route = wssTaskManagerLogRoute(ws, '', {
      jobAddress: 'job-address',
    });
    await vi.advanceTimersByTimeAsync(250);
    await route;

    expect(get).toHaveBeenCalledTimes(2);
    expect(task.subscribe).toHaveBeenCalledWith(ws, expect.any(Function));
    expect(ws.close).not.toHaveBeenCalled();
  });
});
