import TaskManager, { OperationProgressStatuses } from '../TaskManager.js';

/**
 * Restarts a single operation (`opId`) within the currently running group (`group`).
 *
 * This function is meant to be rebound to a `TaskManager` instance using `.bind(this)`, so it can
 * interact with all internal state and methods just like a native class method.
 *
 * The restart process:
 * - Aborts the operation's current execution
 * - Waits for its cleanup to complete
 * - Holds the group's completion to avoid premature advancement
 * - Re-executes the same operation within the current group
 */
export async function restartTaskManagerOperation(
  this: TaskManager,
  group: string,
  opId: string,
): Promise<void> {
  /**
   * Check if the provided group actually exists in the execution plan.
   * If not, it likely means the group name is invalid or not registered.
   */
  const groupExists = this.executionPlan.some((ctx) => ctx.group === group);
  if (!groupExists) throw new Error(`GROUP_NOT_FOUND`);

  /**
   * Only allow restart if the group is the one currently being executed.
   * This prevents restarting ops from already-finished groups or future ones.
   */
  if (this.currentGroup !== group) {
    throw new Error('GROUP_NOT_ACTIVE');
  }

  /**
   * If the operation is already in the process of being restarted or stopped,
   * we don't want to allow another concurrent mutation.
   */
  if (this.lockedOperations.has(opId)) {
    throw new Error(`OPERATION_${this.lockedOperations.get(opId)}`);
  }

  /**
   * Validate the operation exists up front, before we acquire the lock or kick
   * off any async work. This lets the caller (HTTP handler) reject an invalid
   * opId synchronously, and avoids leaving the operation permanently locked if
   * the lookup were to fail later in the flow.
   */
  if (!this.opMap.has(opId)) throw new Error(`INVALID_OPID`);

  // Mark this op as "RESTARTING" so no one else touches it mid-process
  this.lockedOperations.set(opId, 'RESTARTING');
  this.operationStatus.set(opId, OperationProgressStatuses.RESTARTING);

  const emitter = this.operationsEventEmitters.get(opId);
  if (emitter) {
    emitter.emit('log', 'Restarting Operation', 'info');
  }

  /**
   * Get the controller used to abort this operation's execution.
   * This should have been set up when the op was first started.
   */
  const controller = this.abortControllerMap.get(opId);

  /**
   * The following block creates a "placeholder promise" that we temporarily insert into the group’s
   * operation map. This ensures that even if all the original ops complete while we're restarting,
   * the group will not advance to the next one until we explicitly release this block.
   *
   * This is CRITICAL to prevent race conditions where the restart is too late, and the system
   * thinks the group has completed.
   */
  const groupHold = (() => {
    let release!: () => void;
    const placeholder = new Promise<void>((res) => (release = res));

    const abortHandler = () => {
      release();
      this.mainAbortController.signal.removeEventListener(
        'abort',
        abortHandler,
      );
    };

    this.mainAbortController.signal.addEventListener('abort', abortHandler);

    return {
      groupHoldPromisePlaceHolder: placeholder,
      releaseGroupOperationBlock: () => {
        release();
        this.mainAbortController.signal.removeEventListener(
          'abort',
          abortHandler,
        );
      },
    };
  })();

  // Use a special ID to register this placeholder in the group tracking map
  // The op will still retain its original ID for restart purposes
  const placeholderId = `${opId}::restart-block`;
  this.trackGroupOperationPromise(
    placeholderId,
    groupHold.groupHoldPromisePlaceHolder,
  );

  // Abort the currently running operation
  // This should trigger container teardown, logs finalization, and state updates
  controller?.abort('restart');

  /**
   * The container teardown + relaunch below can take a while (graceful container
   * stop, image checks, etc). We deliberately DO NOT await it here: this function
   * is invoked from an HTTP handler whose response is tunneled through frp, and
   * holding the response open for the whole teardown means frp has no live backend
   * for that window and serves its "no backend" (503) page to the caller.
   *
   * Everything that guards against races — the lock, the RESTARTING status and the
   * group-hold placeholder — has already been put in place synchronously above, so
   * it is safe to let the heavy lifting run in the background and return now. The
   * caller gets an immediate acknowledgement that the restart was initiated.
   */
  void (async () => {
    try {
      /**
       * If the operation had already started, wait for it to finish fully (even if it
       * failed). This avoids stomping over any still-pending teardown work.
       */
      const originalPromise = this.currentGroupOperationsPromises.get(opId);
      if (originalPromise) {
        try {
          await originalPromise;
        } catch {
          // We intentionally ignore any error here.
          // Our goal is just to make sure the cleanup is finished, not whether it succeeded.
        }
      }

      /**
       * Now that the original op has been stopped, we need to restart it.
       * Get the latest flow data from storage — this could've been updated elsewhere
       * in the meantime.
       */
      const flow = this.repository.getFlow(this.job);

      /**
       * Re-register the operation for execution and begin tracking it again.
       * This effectively restarts the operation from scratch.
       */
      this.currentGroupOperationsPromises.set(
        opId,
        this.trackGroupOperationPromise(
          opId,
          this.setUpOperationFunc(flow, opId, []),
        ),
      );
    } catch (error: any) {
      emitter?.emit(
        'log',
        `Failed to restart operation: ${error?.message ?? error}`,
        'error',
      );
    } finally {
      /**
       * Release the group hold so the group can eventually complete, and unlock the
       * operation so other calls (like restart or stop) can act on it again. This runs
       * regardless of whether the relaunch succeeded, so we never leave the group held
       * or the operation permanently locked.
       */
      groupHold.releaseGroupOperationBlock();
      this.lockedOperations.delete(opId);
    }
  })();
}
