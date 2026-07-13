import TaskManager, {
  OperationProgressStatuses,
  StopReason,
} from '../TaskManager.js';

/**
 * Immediately stops the current task flow with the given reason.
 *
 * This triggers:
 * - Flow-wide abort via `mainAbortController`
 * - Lifecycle shutdown for any running ops
 * - A consistent status applied to the flow and all ops
 *
 * The stop reason determines what status each op will be marked with.
 *
 * | Reason   | Ops Status |
 * |----------|------------|
 * | expired  | success    |
 * | stopped  | stopped    |
 * | quit     | failed     |
 * | unknown  | failed     |
 *
 * `getStatus()` is used internally to apply the correct status values.
 *
 * The flow status set here is transient: the final result status is derived
 * from the op statuses when `start()` completes — 'failed' if any op failed,
 * 'success' otherwise.
 */
export function stopAllTaskManagerOperations(
  this: TaskManager,
  reason: StopReason,
): void {
  /**
   * Resolve the correct flow-level status from the stop reason.
   * This ensures consistent results across all status tracking.
   */
  this.status = this.getStatus(reason, 'flow');

  /**
   * Abort the main controller signal, which in turn should cascade
   * down to any op-level AbortControllers that are still active.
   */
  this.mainAbortController.abort(reason);

  /**
   * Mark any operations that have NOT started yet as stopped in the repository.
   */
  try {
    const flow = this.repository.getFlow(this.job);
    if (!flow) return;

    const now = Date.now();
    for (const [opId] of this.opMap) {
      const index = this.getOpStateIndex(opId);
      const opState = flow.state.opStates[index];
      if (opState?.startTime) continue;

      this.operationStatus.set(opId, OperationProgressStatuses.STOPPED);

      this.repository.updateOpState(this.job, index, {
        status: this.getStatus(reason, 'ops'),
        endTime: now,
        exitCode: 0,
      });
    }
  } catch {}
}
