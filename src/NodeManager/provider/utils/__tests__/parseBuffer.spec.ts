import { describe, it, expect } from 'vitest';

import { parseLogFrames } from '../parseBuffer.js';

/** Encode a single Docker multiplexed log frame (non-TTY stream format). */
function frame(type: 'stdout' | 'stderr', payload: string): Buffer {
  const body = Buffer.from(payload, 'utf-8');
  const header = Buffer.alloc(8);
  header.writeUInt8(type === 'stdout' ? 1 : 2, 0);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

describe('parseLogFrames', () => {
  it('decodes every frame packed into a single buffer', () => {
    const buffer = Buffer.concat([
      frame('stderr', '2026-06-08T00:51:01Z \n'),
      frame('stdout', '2026-06-08T00:51:01Z {"devices":[]}\n'),
    ]);

    const { logs, rest } = parseLogFrames(buffer);

    expect(logs).toEqual([
      { log: '\n', type: 'stderr', timestamp: '2026-06-08T00:51:01Z' },
      {
        log: '{"devices":[]}\n',
        type: 'stdout',
        timestamp: '2026-06-08T00:51:01Z',
      },
    ]);
    expect(rest.length).toBe(0);
  });

  it('returns an incomplete trailing frame as leftover bytes', () => {
    const complete = frame('stderr', '2026-06-08T00:51:01Z done\n');
    const partial = frame('stdout', '2026-06-08T00:51:01Z {"devices":[]}\n');
    const buffer = Buffer.concat([complete, partial.subarray(0, 10)]);

    const { logs, rest } = parseLogFrames(buffer);

    expect(logs).toEqual([
      { log: 'done\n', type: 'stderr', timestamp: '2026-06-08T00:51:01Z' },
    ]);
    expect(rest).toEqual(partial.subarray(0, 10));
  });

  it('returns no logs for an empty buffer', () => {
    const { logs, rest } = parseLogFrames(Buffer.alloc(0));
    expect(logs).toEqual([]);
    expect(rest.length).toBe(0);
  });
});
