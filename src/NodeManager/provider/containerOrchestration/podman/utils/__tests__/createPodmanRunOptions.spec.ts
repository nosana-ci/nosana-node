import { describe, it, expect } from 'vitest';

import { createPodmanRunOptions } from '../createPodmanRunOptions.js';

describe('createPodmanRunOptions', () => {
  it('adds /dev/sev-guest to devices for SEV-GUEST', () => {
    const options = createPodmanRunOptions(
      'ubuntu',
      { name: 'test', runtime: 'SEV-GUEST' },
      'all',
    );
    expect(options.devices).toEqual([{ path: '/dev/sev-guest' }]);
  });

  it('adds no devices without gpu or TEE runtime', () => {
    const options = createPodmanRunOptions('ubuntu', { name: 'test' }, 'all');
    expect(options.devices).toEqual([]);
  });
});
