import { afterEach, describe, expect, it, vi } from 'vitest';

import { IpfsClientSingleton } from '../../../../ipfs/IpfsClient.js';
import { JobExternalUtil } from '../jobExternalUtil.js';

describe('JobExternalUtil job definition retrieval', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('retries with a short backoff after a transient IPFS failure', async () => {
    vi.useFakeTimers();
    const jobDefinition = { version: '0.1' };
    const retrieve = vi
      .spyOn(IpfsClientSingleton, 'retrieve')
      .mockRejectedValueOnce(new Error('temporary gateway failure'))
      .mockResolvedValue(jobDefinition);
    const util = new JobExternalUtil({} as any);

    const result = (util as any).retrieveJobDefinitionWithRetry('ipfs-hash');

    expect(retrieve).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(retrieve).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBe(jobDefinition);
    expect(retrieve).toHaveBeenCalledTimes(2);
  });

  it('keeps a final recovery attempt at the original 20-second point', async () => {
    vi.useFakeTimers();
    const error = new Error('gateway unavailable');
    const retrieve = vi
      .spyOn(IpfsClientSingleton, 'retrieve')
      .mockRejectedValue(error);
    const util = new JobExternalUtil({} as any);

    const result = (util as any).retrieveJobDefinitionWithRetry('ipfs-hash');
    const rejection = expect(result).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(retrieve).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);

    await rejection;
    expect(retrieve).toHaveBeenCalledTimes(4);
  });
});
