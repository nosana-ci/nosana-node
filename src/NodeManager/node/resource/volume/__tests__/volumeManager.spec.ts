import { describe, it, expect } from 'vitest';

import { readFileSync } from 'fs';
import { join } from 'path';

import { findReportedError } from '../volumeManager.js';
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

describe('findReportedError', () => {
  it.each([
    ['a hugging face download', HF_ERROR, 'Failed to download model.safetensors'],
    ['an ollama manifest fetch', OLLAMA_ERROR, 'Failed to fetch manifest for model gemma4:26b'],
  ])('reads the reason the resource manager reported for %s', (_label, line, expected) => {
    expect(findReportedError([{ log: line }])).toContain(expected);
  });

  it('reads it through the real log decoder, header and timestamp included', () => {
    const buffer = Buffer.concat([
      frame('stderr', `2026-07-31T08:00:00Z ${PROGRESS}\n`),
      frame('stderr', `2026-07-31T08:00:01Z ${HF_ERROR}\n`),
    ]);

    const { logs } = extractLogsAndResultsFromLogBuffer(buffer, undefined);

    expect(findReportedError(logs)).toContain('786432 bytes transferred');
  });

  it('ignores progress lines, which share the same stream', () => {
    expect(findReportedError([{ log: PROGRESS }])).toBeUndefined();
  });

  it('takes the last reported error when a run logs several', () => {
    const first = '{"event":"error","message":"Failed to download a.bin - timeout"}';
    const last = '{"event":"error","message":"Failed to download b.bin - terminated"}';

    expect(findReportedError([{ log: first }, { log: last }])).toContain('b.bin');
  });

  it.each([
    ['no logs at all', []],
    ['a container that logged nothing usable', [{ log: '' }, { log: undefined }]],
    ['plain text with no envelope', [{ log: 'downloading...' }]],
    ['a truncated envelope', [{ log: '{"event":"error","mess' }]],
  ])('returns undefined for %s, so the caller falls back to the exit code', (_label, logs) => {
    expect(findReportedError(logs)).toBeUndefined();
  });

  it('does not match the legacy `Error:` prefix, which the container never emits', () => {
    expect(findReportedError([{ log: 'Error: boom' }])).toBeUndefined();
  });
});

describe('against real container output', () => {
  const load = (file: string) =>
    readFileSync(join(__dirname, file), 'utf-8')
      .split('\n')
      .map((log) => ({ log }));

  it('reads the reason a missing file is reported with', () => {
    expect(findReportedError(load('real-envelope.txt'))).toBe(
      'Failed to download does-not-exist.bin - Failed to fetch: 404',
    );
  });

  // The container is expected to report every failure through the envelope; a
  // crash that bypasses it leaves the caller with the exit code, rather than
  // this guessing at output it does not control.
  it('reads nothing from a crash that reported no envelope', () => {
    expect(findReportedError(load('real-crash.txt'))).toBeUndefined();
  });
});
