import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { retryFetch } from '../retryFetch.js';
import { HostManagerUnreachableError } from '../../errors/HostManagerUnreachableError.js';

const fetchFailed = (code: string) =>
  new TypeError('fetch failed', {
    cause: Object.assign(new Error(`request failed`), { code }),
  });

const makeRequest = () =>
  new Request('https://host.test/benchmarks/1/submit-results', {
    method: 'POST',
    body: '{"results":true}',
  });

describe('retryFetch', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns the response on first success without retrying', async () => {
    fetchMock.mockResolvedValue(new Response('ok'));

    const response = await retryFetch(makeRequest());

    expect(await response.text()).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns HTTP error responses untouched without retrying', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));

    const response = await retryFetch(makeRequest());

    expect(response.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries network failures with backoff and succeeds', async () => {
    fetchMock
      .mockRejectedValueOnce(fetchFailed('ECONNRESET'))
      .mockRejectedValueOnce(fetchFailed('ECONNRESET'))
      .mockResolvedValue(new Response('ok'));

    const promise = retryFetch(makeRequest());
    await vi.runAllTimersAsync();
    const response = await promise;

    expect(await response.text()).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('sends a readable body on every attempt', async () => {
    const bodies: string[] = [];
    fetchMock.mockImplementation(async (request: Request) => {
      bodies.push(await request.text());
      if (bodies.length < 2) throw fetchFailed('ECONNRESET');
      return new Response('ok');
    });

    const promise = retryFetch(makeRequest());
    await vi.runAllTimersAsync();
    await promise;

    expect(bodies).toEqual(['{"results":true}', '{"results":true}']);
  });

  it('throws HostManagerUnreachableError with the cause after exhausting attempts', async () => {
    fetchMock.mockRejectedValue(fetchFailed('EAI_AGAIN'));

    const promise = retryFetch(makeRequest()).catch((e) => e);
    await vi.runAllTimersAsync();
    const error = await promise;

    expect(error).toBeInstanceOf(HostManagerUnreachableError);
    expect(error.message).toContain('after 6 attempts');
    expect(error.message).toContain('EAI_AGAIN');
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});
