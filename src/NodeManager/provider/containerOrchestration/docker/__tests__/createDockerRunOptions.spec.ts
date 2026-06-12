import { describe, it, expect } from 'vitest';

import { createDockerRunOptions } from '../createDockerRunOptions.js';

const sevGuestDevice = {
  PathOnHost: '/dev/sev-guest',
  PathInContainer: '/dev/sev-guest',
  CgroupPermissions: 'r',
};

describe('createDockerRunOptions', () => {
  it('mounts /dev/sev-guest and sets the custom runtime for SEV-SNP', () => {
    const options = createDockerRunOptions(
      'ubuntu',
      { name: 'test', runtime: 'SEV-SNP' },
      'all',
    );
    expect(options.HostConfig?.Devices).toEqual([sevGuestDevice]);
    expect(options.HostConfig?.Runtime).toBe('SEV-SNP');
  });

  it('mounts /dev/sev-guest without a custom runtime for SEV-GUEST', () => {
    const options = createDockerRunOptions(
      'ubuntu',
      { name: 'test', runtime: 'SEV-GUEST' },
      'all',
    );
    expect(options.HostConfig?.Devices).toEqual([sevGuestDevice]);
    expect(options.HostConfig?.Runtime).toBeUndefined();
  });

  it('sets neither device nor runtime when no TEE runtime is given', () => {
    const options = createDockerRunOptions('ubuntu', { name: 'test' }, 'all');
    expect(options.HostConfig?.Devices).toBeUndefined();
    expect(options.HostConfig?.Runtime).toBeUndefined();
  });
});
