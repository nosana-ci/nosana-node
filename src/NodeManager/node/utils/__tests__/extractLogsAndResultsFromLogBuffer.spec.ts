import { describe, it, expect } from 'vitest';

import { extractLogsAndResultsFromLogBuffer } from '../extractLogsAndResultsFromLogBuffer.js';

/** Encode a single Docker multiplexed log frame (non-TTY stream format). */
function frame(type: 'stdout' | 'stderr', payload: string): Buffer {
  const body = Buffer.from(payload, 'utf-8');
  const header = Buffer.alloc(8);
  header.writeUInt8(type === 'stdout' ? 1 : 2, 0);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

describe('extractLogsAndResultsFromLogBuffer', () => {
  it('decodes each frame in the buffer exactly once, in order', () => {
    const buffer = Buffer.concat([
      frame('stderr', '2026-06-08T00:51:01Z Error: boom\n'),
      frame('stderr', '2026-06-08T00:51:01Z second line\n'),
      frame('stdout', '2026-06-08T00:51:01Z done\n'),
    ]);

    const { logs } = extractLogsAndResultsFromLogBuffer(buffer, undefined);

    expect(logs.map((l) => l.log)).toEqual([
      'Error: boom\n',
      'second line\n',
      'done\n',
    ]);
  });
});
