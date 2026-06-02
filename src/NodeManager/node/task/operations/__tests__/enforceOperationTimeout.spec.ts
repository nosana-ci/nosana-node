import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

import { enforceOperationTimeout } from '../enforceOperationTimeout.js';

describe('enforceOperationTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onTimeout once the container has been running for the full timeout', () => {
    const emitter = new EventEmitter();
    const onTimeout = vi.fn();

    enforceOperationTimeout(emitter, 2, onTimeout);
    emitter.emit('container:started');

    // Clock starts on `container:started`, and the unit is seconds.
    vi.advanceTimersByTime(1999);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('does not count image-pull time: `start` alone does not arm the timer', () => {
    const emitter = new EventEmitter();
    const onTimeout = vi.fn();

    enforceOperationTimeout(emitter, 1, onTimeout);

    // `start` fires before the image pull — the timer must not arm yet.
    emitter.emit('start');
    vi.advanceTimersByTime(5000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('clears the timer when the op exits before the timeout', () => {
    const emitter = new EventEmitter();
    const onTimeout = vi.fn();

    enforceOperationTimeout(emitter, 5, onTimeout);
    emitter.emit('container:started');
    vi.advanceTimersByTime(1000);
    emitter.emit('exit', { exitCode: 0 });

    vi.advanceTimersByTime(10000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('clears the timer when the op errors before the timeout', () => {
    const emitter = new EventEmitter();
    const onTimeout = vi.fn();

    enforceOperationTimeout(emitter, 5, onTimeout);
    emitter.emit('container:started');
    emitter.emit('error', new Error('boom'));

    vi.advanceTimersByTime(10000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('clears the timer when the op is torn down (`end`)', () => {
    const emitter = new EventEmitter();
    const onTimeout = vi.fn();

    enforceOperationTimeout(emitter, 5, onTimeout);
    emitter.emit('container:started');
    emitter.emit('end');

    vi.advanceTimersByTime(10000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, -1])(
    'is a no-op when the timeout is %s',
    (timeout) => {
      const emitter = new EventEmitter();
      const onTimeout = vi.fn();

      enforceOperationTimeout(emitter, timeout as number | undefined, onTimeout);
      emitter.emit('container:started');

      vi.advanceTimersByTime(60_000);
      expect(onTimeout).not.toHaveBeenCalled();
    },
  );

  it('re-arms (and does not duplicate) when the container starts again', () => {
    const emitter = new EventEmitter();
    const onTimeout = vi.fn();

    enforceOperationTimeout(emitter, 2, onTimeout);

    emitter.emit('container:started');
    vi.advanceTimersByTime(1500); // partway through the first window
    emitter.emit('container:started'); // a fresh start resets the clock

    vi.advanceTimersByTime(1999);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});
