import { describe, it, expect } from 'vitest';

import { liveAbortSignal } from '../liveAbortSignal.js';

describe('liveAbortSignal', () => {
  it('passes through a signal that has not been aborted', () => {
    const controller = new AbortController();
    expect(liveAbortSignal(controller.signal)).toBe(controller.signal);
  });

  it('drops an already-aborted signal so docker-modem never receives it', () => {
    const controller = new AbortController();
    controller.abort('expired');
    expect(liveAbortSignal(controller.signal)).toBeUndefined();
  });

  it('returns undefined for an undefined signal', () => {
    expect(liveAbortSignal(undefined)).toBeUndefined();
  });
});
