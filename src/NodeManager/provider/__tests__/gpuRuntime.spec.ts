import { describe, expect, it } from 'vitest';

import { isStaleGpuRuntimeError } from '../gpuRuntime.js';

describe('isStaleGpuRuntimeError', () => {
  it('matches podman failing to set up the CDI devices at create', () => {
    // libpod returns its error as a plain object, not an Error
    expect(
      isStaleGpuRuntimeError({
        cause: 'unresolvable CDI devices nvidia.com/gpu=all',
        message:
          'setting up CDI devices: unresolvable CDI devices nvidia.com/gpu=all',
        response: 500,
      }),
    ).toBe(true);
  });

  it('matches the runtime failing to bind a replaced driver file at start', () => {
    expect(
      isStaleGpuRuntimeError(
        new Error(
          'Cannot start container: crun: error mounting `/usr/lib/x86_64-linux-gnu/libcuda.so.550.120.04` to rootfs at `/usr/lib/x86_64-linux-gnu/libcuda.so.550.120.04`: No such file or directory: OCI runtime attempted to invoke a command that was not found',
        ),
      ),
    ).toBe(true);
    expect(
      isStaleGpuRuntimeError(
        new Error("crun: error stat'ing file `/dev/nvidia0`: No such file or directory"),
      ),
    ).toBe(true);
  });

  it('matches the toolkit hook failing', () => {
    expect(
      isStaleGpuRuntimeError(new Error('nvidia-container-cli: mount error')),
    ).toBe(true);
  });

  it('ignores failures of the container itself, even for an NVIDIA image', () => {
    expect(
      isStaleGpuRuntimeError({
        message: 'docker.io/nvidia/cuda:12.4.1-base-ubuntu22.04: image not known',
      }),
    ).toBe(false);
    expect(
      isStaleGpuRuntimeError(
        new Error('reading manifest for nvidia/cuda: HTTP status 401'),
      ),
    ).toBe(false);
    expect(isStaleGpuRuntimeError('exit code 137')).toBe(false);
  });
});
