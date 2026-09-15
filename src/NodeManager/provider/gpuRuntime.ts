/**
 * What the provider needs of the node's podman manager, when the node
 * manages podman.
 */
export interface GpuRuntime {
  /** Resolves once no recreate is in flight: operation starts wait on this. */
  ready(): Promise<void>;
  /** Whether podman's own watcher has found the GPU runtime stale. */
  isStale(): boolean;
  /** Replace the runtime; the operations running on it are restarted around it. */
  recreate(reason: string): Promise<void>;
}

/**
 * How a container start fails when the podman container's copy of the host's
 * NVIDIA driver no longer matches the host. Recreating podman is what fixes
 * it, so these are told apart from failures of the container itself.
 *
 * - At create, podman could not resolve or inject the CDI spec:
 *   "setting up CDI devices: unresolvable CDI devices nvidia.com/gpu=all".
 * - At start, the OCI runtime could not bind a driver file the spec names,
 *   because the host replaced it: "crun: error mounting
 *   `/usr/lib/x86_64-linux-gnu/libcuda.so.550.120.04` to rootfs ...: No such
 *   file or directory". The file need not carry "nvidia" in its name.
 * - The toolkit's own hook failed: "nvidia-container-cli: mount error".
 *
 * An image that happens to be NVIDIA's ("nvidia/cuda: image not known") is
 * not a match: that is the container's failure, not the runtime's.
 */
const STALE_GPU_RUNTIME = [
  /setting up CDI devices|unresolvable CDI devices/i,
  /nvidia-container-(cli|runtime)/i,
  /\b(mount|mounting|stat)\b[^\n]*?(\/dev\/nvidia|libnvidia|libcuda|libnv|nvidia-smi|nvidia-persistenced)/i,
];

export function isStaleGpuRuntimeError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : String((error as any)?.message ?? error);
  return STALE_GPU_RUNTIME.some((pattern) => pattern.test(message));
}
