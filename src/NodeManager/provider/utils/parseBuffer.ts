import { Log, StdOptions } from '@nosana/sdk';

const TIMESTAMP_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\s/;

const DOCKER_LOG_HEADER_BYTES = 8;

/**
 * Demultiplex every complete Docker log frame contained in `buffer`.
 *
 * A non-TTY container log stream is a sequence of frames, each an 8-byte header
 * (stream type + big-endian payload length) followed by the payload. The stream
 * layer may pack several frames into one read *and* split a single frame across
 * reads, so a caller following a live stream must feed the returned `rest` (an
 * incomplete trailing frame, if any) back in alongside the next chunk.
 */
export function parseLogFrames(buffer: Buffer): { logs: Log[]; rest: Buffer } {
  const logs: Log[] = [];
  let index = 0;

  while (index + DOCKER_LOG_HEADER_BYTES <= buffer.length) {
    const chunkLength = buffer.readUInt32BE(index + 4);
    const end = index + DOCKER_LOG_HEADER_BYTES + chunkLength;
    if (end > buffer.length) break; // frame has not fully arrived yet

    logs.push(parseBuffer(buffer, index));
    index = end;
  }

  return { logs, rest: buffer.subarray(index) };
}

export function parseBuffer(buffer: Buffer, index: number = 0): Log {
  const head = buffer.subarray(index, (index += 8));
  const chunkType = head.readUInt8(0);
  const chunkLength = head.readUInt32BE(4);
  const content = buffer.subarray(index, (index += chunkLength));

  const rawLog = content.toString('utf-8');
  const timestampMatch = rawLog.match(TIMESTAMP_REGEX);
  const log = rawLog.replace(TIMESTAMP_REGEX, '');

  let timestamp: string = new Date(Date.now()).toISOString();
  if (timestampMatch) {
    timestamp = timestampMatch[0].trim();
  }

  return {
    log,
    type: chunkType === 1 ? 'stdout' : ('stderr' as StdOptions),
    timestamp,
  };
}
