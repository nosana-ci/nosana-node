import WebSocket from 'ws';
import { logStreaming } from '../../../../monitoring/streaming/LogStreamer.js';
import { getSDK } from '../../../../sdk/index.js';
import { TaskManagerRegistry } from '../../../task/TaskManagerRegistry.js';
import { TaskLog } from '../../../task/TaskManager.js';

/**
 * this is for log streaming, this is going to be used by the basic job poster
 * just to show that clients logs, both from the node and the container
 */
export async function wssLogRoute(
  ws: WebSocket,
  _: string,
  { jobAddress }: { jobAddress: string },
) {
  const sdk = getSDK();
  const walletAddress = sdk.solana.wallet.toString();

  logStreaming(walletAddress).subscribe(ws, jobAddress);
}

export async function wssTaskManagerLogRoute(
  ws: WebSocket,
  _: string,
  {
    jobAddress,
    group,
    opId,
    type,
  }: {
    jobAddress: string;
    group?: string;
    opId?: string;
    type?: string;
  },
) {
  const registry = TaskManagerRegistry.getInstance();
  const deadline = Date.now() + 30_000;
  let task = registry.get(jobAddress);

  // A run is visible on-chain before the node has finished loading the job
  // definition and registering its TaskManager. Keep the authenticated socket
  // open during that short startup window instead of forcing clients to race it.
  while (!task && Date.now() < deadline && ws.readyState === WebSocket.OPEN) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    task = registry.get(jobAddress);
  }

  if (!task) return ws.close(1008, 'Invalid job address');

  task.subscribe(ws, (log: TaskLog) => {
    return (
      (!group || log.group === group) &&
      (!opId || log.opId === opId) &&
      (!type || log.type === type)
    );
  });

  // Send historical logs first (optional)
  const logs = opId
    ? task.getLogsByOp(opId)
    : group
    ? task.getLogsByGroup(group)
    : task.getAllLogs();

  for (const log of logs) {
    try {
      ws.send(JSON.stringify({ path: 'flog', data: JSON.stringify(log) }));
    } catch {
      // The client may disconnect while historical logs are being replayed.
    }
  }
}
