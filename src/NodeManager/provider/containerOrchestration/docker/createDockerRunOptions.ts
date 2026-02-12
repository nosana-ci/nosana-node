import { ContainerCreateOptions } from "dockerode";
import type { RestartPolicy } from '@nosana/sdk';
import { RunContainerArgs } from "../interface";

function parseRestartPolicy(restart_policy: RestartPolicy | '' | undefined) {
  if (typeof restart_policy === 'string') {
    return restart_policy ? { Name: restart_policy, MaximumRetryCount: 0 } : undefined;
  }
  if (typeof restart_policy === 'object' && 'policy' in restart_policy) {
    return {
      Name: restart_policy.policy,
      MaximumRetryCount: restart_policy.restart_tries || 0,
    };
  }
  return undefined;
}

export function createDockerRunOptions(
  image: string,
  {
    name,
    cmd,
    gpu,
    volumes,
    env,
    work_dir,
    entrypoint,
    aliases,
    restart_policy,
  }: RunContainerArgs,
  gpuOption: string,
): ContainerCreateOptions {
  const devices = [];

  if (gpu) {
    devices.push({
      ...(gpuOption === 'all'
        ? { Count: -1 }
        : { device_ids: gpuOption.split(',') }),
      Driver: 'nvidia',
      Capabilities: [['gpu']],
    })
  };

  return {
    name: name,
    Hostname: '',
    User: '',
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    OpenStdin: false,
    StdinOnce: false,
    Env: Object.entries(env ?? {}).map(([key, value]) => `${key}=${value.toString()}`),
    Cmd: cmd,
    Image: image,
    WorkingDir: work_dir,
    Entrypoint: entrypoint,
    NetworkingConfig: {
      EndpointsConfig: {
        NOSANA_GATEWAY: aliases ? { Aliases: aliases } : {},
      },
    },
    HostConfig: {
      ExtraHosts: [
        'host.docker.internal:8.8.8.8',
        'host.containers.internal:8.8.8.8',
      ],
      Mounts: volumes?.map(({ dest, name, readonly }) => ({
        Target: dest,
        Source: name,
        Type: 'volume',
        ReadOnly: readonly || false,
      })),
      NetworkMode: 'bridge',
      DeviceRequests: devices,
      RestartPolicy: parseRestartPolicy(restart_policy),
    },
  };
}