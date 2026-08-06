import { describe, it, expect } from 'vitest';

import { readFileSync } from 'fs';
import { join } from 'path';

import { ContainerInspectInfo } from 'dockerode';

import {
  describeContainerState,
  describeUnreportedExit,
  findReportedErrors,
} from '../volumeManager.js';
import { extractLogsAndResultsFromLogBuffer } from '../../../utils/extractLogsAndResultsFromLogBuffer.js';

/** Encode a single Docker multiplexed log frame (non-TTY stream format). */
function frame(type: 'stdout' | 'stderr', payload: string): Buffer {
  const body = Buffer.from(payload, 'utf-8');
  const header = Buffer.alloc(8);
  header.writeUInt8(type === 'stdout' ? 1 : 2, 0);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** Lines exactly as the resource manager emits them, one per service. */
const HF_ERROR =
  '{"event":"error","message":"Failed to download model.safetensors - terminated (failed after 3 attempts, 786432 bytes transferred)"}';
const OLLAMA_ERROR =
  '{"event":"error","message":"Failed to fetch manifest for model gemma4:26b - Not Found"}';
const PROGRESS =
  '{"event":"status","size":{"current":1024,"total":4096},"count":{"current":1,"total":9}}';

describe('findReportedErrors', () => {
  it.each([
    ['a hugging face download', HF_ERROR, 'Failed to download model.safetensors'],
    ['an ollama manifest fetch', OLLAMA_ERROR, 'Failed to fetch manifest for model gemma4:26b'],
  ])('reads the reason the resource manager reported for %s', (_label, line, expected) => {
    expect(findReportedErrors([{ log: line }]).at(-1)).toContain(expected);
  });

  it('reads it through the real log decoder, header and timestamp included', () => {
    const buffer = Buffer.concat([
      frame('stderr', `2026-07-31T08:00:00Z ${PROGRESS}\n`),
      frame('stderr', `2026-07-31T08:00:01Z ${HF_ERROR}\n`),
    ]);

    const { logs } = extractLogsAndResultsFromLogBuffer(buffer, undefined);

    expect(findReportedErrors(logs).at(-1)).toContain('786432 bytes transferred');
  });

  it('ignores progress lines, which share the same stream', () => {
    expect(findReportedErrors([{ log: PROGRESS }])).toEqual([]);
  });

  it('collects every reported error when a run logs several, in order', () => {
    const first = '{"event":"error","message":"Failed to download a.bin - timeout"}';
    const last = '{"event":"error","message":"Failed to download b.bin - terminated"}';

    expect(findReportedErrors([{ log: first }, { log: last }])).toEqual([
      'Failed to download a.bin - timeout',
      'Failed to download b.bin - terminated',
    ]);
  });

  it.each([
    ['no logs at all', []],
    ['a container that logged nothing usable', [{ log: '' }, { log: undefined }]],
    ['plain text with no envelope', [{ log: 'downloading...' }]],
    ['a truncated envelope', [{ log: '{"event":"error","mess' }]],
  ])('reports nothing for %s, so the caller falls back to the exit code', (_label, logs) => {
    expect(findReportedErrors(logs)).toEqual([]);
  });

  it('does not match the legacy `Error:` prefix, which the container never emits', () => {
    expect(findReportedErrors([{ log: 'Error: boom' }])).toEqual([]);
  });
});

describe('describeUnreportedExit', () => {
  it('carries the stderr tail, the only account of a crash without an envelope', () => {
    const logs = [
      { log: 'node:internal/errors:496' },
      { log: '    throw error;' },
      { log: '' },
      { log: 'Error: EACCES: permission denied' },
      { log: 'Node.js v22.16.0' },
    ];

    expect(describeUnreportedExit(logs, 1)).toBe(
      'no reason reported (exit code 1); stderr tail: throw error; | Error: EACCES: permission denied | Node.js v22.16.0',
    );
  });

  it('reports the exit code alone when the container wrote nothing at all', () => {
    expect(describeUnreportedExit([], 1)).toBe(
      'no reason reported (exit code 1)',
    );
  });
});

describe('describeContainerState', () => {
  /** Only the fields the renderer reads, shaped like a real inspect result. */
  const state = (
    overrides: Partial<ContainerInspectInfo['State']> = {},
  ): ContainerInspectInfo['State'] =>
    ({
      ExitCode: 1,
      OOMKilled: false,
      Error: '',
      StartedAt: '2026-08-06T04:15:49.270Z',
      FinishedAt: '2026-08-06T05:06:57.503Z',
      ...overrides,
    } as ContainerInspectInfo['State']);

  it('reports the exit code, the OOM flag and how long the container ran', () => {
    expect(describeContainerState(state())).toBe(
      ' [exitCode: 1, OOMKilled: false, ran for 51m 8s]',
    );
  });

  it('includes the runtime error for a container Docker could not start', () => {
    const failed = state({
      ExitCode: 128,
      Error: 'OCI runtime create failed: no such device',
      StartedAt: '0001-01-01T00:00:00Z',
      FinishedAt: '0001-01-01T00:00:00Z',
    });

    expect(describeContainerState(failed)).toBe(
      ' [exitCode: 128, OOMKilled: false, error: OCI runtime create failed: no such device]',
    );
  });

  it('omits the duration while the container is still running', () => {
    const running = state({ FinishedAt: '0001-01-01T00:00:00Z' });

    expect(describeContainerState(running)).toBe(
      ' [exitCode: 1, OOMKilled: false]',
    );
  });

  it('returns nothing when the inspect itself failed', () => {
    expect(describeContainerState(undefined)).toBe('');
  });
});

describe('against real container output', () => {
  const load = (file: string) =>
    readFileSync(join(__dirname, file), 'utf-8')
      .split('\n')
      .map((log) => ({ log }));

  it('reads the reason a missing file is reported with', () => {
    expect(findReportedErrors(load('real-envelope.txt'))).toEqual([
      'Failed to download does-not-exist.bin - Failed to fetch: 404',
    ]);
  });

  // The container is expected to report every failure through the envelope; a
  // crash that bypasses it leaves the caller with the exit code, rather than
  // this guessing at output it does not control.
  it('reads nothing from a crash that reported no envelope', () => {
    expect(findReportedErrors(load('real-crash.txt'))).toEqual([]);
  });

  it('still surfaces such a crash through the stderr tail', () => {
    expect(describeUnreportedExit(load('real-crash.txt'), 1)).toContain(
      'Node.js v22.16.0',
    );
  });
});
