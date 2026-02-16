import TaskManager from '../TaskManager.js';

export function setContainerIp(this: TaskManager, opId: string, internalIp: string): void {
  const op = (this.globalOpStore[opId] ??= {});

  op.container_ip = internalIp;

  // Host updated; attempt endpoint rehydration for this op
  const flow = this.repository.getFlow(this.job);
  if (flow) {
    this.rehydrateEndpointsForOperation(
      flow.id,
      flow.project,
      flow.jobDefinition,
      opId,
    );
  }
}
