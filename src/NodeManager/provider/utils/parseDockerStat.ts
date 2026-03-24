import type Dockerode from 'dockerode';
import type { TaskStat } from '../../node/task/TaskManager.js';

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

function cpuPercent(raw: Dockerode.ContainerStats): number {
  const cpuDelta =
    raw.cpu_stats.cpu_usage.total_usage - raw.precpu_stats.cpu_usage.total_usage;
  const systemDelta =
    raw.cpu_stats.system_cpu_usage - raw.precpu_stats.system_cpu_usage;
  const numCpus =
    raw.cpu_stats.online_cpus ?? raw.cpu_stats.cpu_usage.percpu_usage?.length ?? 1;
  return systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;
}

function networkBytes(raw: Dockerode.ContainerStats): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  if (raw.networks) {
    for (const iface of Object.values(raw.networks)) {
      rx += iface.rx_bytes;
      tx += iface.tx_bytes;
    }
  }
  return { rx, tx };
}

function blockBytes(raw: Dockerode.ContainerStats): { read: number; write: number } {
  let read = 0;
  let write = 0;
  for (const entry of raw.blkio_stats?.io_service_bytes_recursive ?? []) {
    if (entry.op.toLowerCase() === 'read') read += entry.value;
    else if (entry.op.toLowerCase() === 'write') write += entry.value;
  }
  return { read, write };
}

export function parseDockerStat(
  raw: Dockerode.ContainerStats,
): Omit<TaskStat, 'opId'> | null {
  try {
    const cpu = cpuPercent(raw);
    const memory_usage_bytes: number = raw.memory_stats.usage ?? 0;
    const memory_limit_bytes: number = raw.memory_stats.limit ?? 0;
    const memory_percent =
      memory_limit_bytes > 0 ? (memory_usage_bytes / memory_limit_bytes) * 100 : 0;
    const net = networkBytes(raw);
    const blk = blockBytes(raw);

    return {
      timestamp: new Date(raw.read).getTime() || Date.now(),
      cpu: {
        cpu_percent: parseFloat(Math.max(0, cpu).toFixed(2)),
      },
      memory: {
        memory_usage: parseFloat((memory_usage_bytes / MB).toFixed(2)),
        memory_limit: parseFloat((memory_limit_bytes / GB).toFixed(2)),
        memory_percent: parseFloat(Math.max(0, memory_percent).toFixed(2)),
      },
      disk: {
        read: parseFloat((blk.read / MB).toFixed(2)),
        write: parseFloat((blk.write / MB).toFixed(2)),
      },
      network: {
        received: parseFloat((net.rx / MB).toFixed(2)),
        sent: parseFloat((net.tx / MB).toFixed(2)),
      },
    };
  } catch {
    return null;
  }
}
