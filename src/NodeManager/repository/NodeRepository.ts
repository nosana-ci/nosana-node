import type { LowSync } from 'lowdb';
import type { Flow, OpState, FlowState } from '@nosana/sdk';

import type {
  NodeDb,
  ResourceHistory,
  VolumeResource,
} from '../db/index.js';
import { reportError } from '../monitoring/reportError.js';
import { isTerminalGone } from '../utils/tolerateBrokenStdio.js';

const MAX_LOGS = 24999;

/** How often an unchanged persist failure is repeated, rather than per write. */
const PERSIST_REPORT_INTERVAL_MS = 5 * 60 * 1000;

/** A dead terminal must not resurrect the throw a caller is containing. */
function printToOperator(message: string): void {
  try {
    console.error(message);
  } catch (error) {
    if (!isTerminalGone(error)) throw error;
  }
}

/**
 * A persist failure and what the operator has to do about this errno. Until it
 * is done the node runs on in-memory state and loses it on restart.
 */
function describePersistFailure(message: string): string {
  let advice = 'Check that the node data directory is writable.';

  if (message.includes('ENOSPC')) {
    advice =
      'The disk is full. Free space on the node — job state cannot be saved until then, ' +
      'and will be lost if the node restarts.';
  } else if (message.includes('EROFS')) {
    advice = 'The node data directory is mounted read-only and must be made writable.';
  }

  return `Failed to save node state: ${message}. ${advice}`;
}

export class NodeRepository {
  constructor(private db: LowSync<NodeDb>) { }

  private lastPersistError?: string;
  private lastPersistReportAt = 0;

  /**
   * Write the database to disk, reporting rather than throwing when it cannot.
   *
   * lowdb writes synchronously, so a disk fault throws into container handlers,
   * where it escapes uncaught, and into the awaited flow paths, where it fails
   * the operation. The in-memory update is already applied, so only durability
   * depends on this.
   */
  private persist(): void {
    try {
      this.db.write();
      this.lastPersistError = undefined;
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      const now = Date.now();
      const isRepeat =
        message === this.lastPersistError &&
        now - this.lastPersistReportAt < PERSIST_REPORT_INTERVAL_MS;

      if (isRepeat) return;

      this.lastPersistError = message;
      this.lastPersistReportAt = now;

      const description = describePersistFailure(message);

      printToOperator(description);

      void reportError({
        error_type: 'persistFailure',
        error_name: (error as Error)?.name ?? 'Error',
        error_message: description,
        error_stack: (error as Error)?.stack ?? '',
      });
    }
  }

  public getFlow(id: string): Flow {
    return this.db.data.flows[id];
  }

  public getFlows(): { [key: string]: Flow } {
    return this.db.data.flows;
  }

  public setflow(id: string, flow: Flow): void {
    this.db.data.flows[id] = flow;
    this.persist();
  }

  public deleteflow(id: string): void {
    delete this.db.data.flows[id];
    this.persist();
  }

  public addOpstate(id: string, opstate: OpState): void {
    const opStates = this.db.data.flows[id]?.state?.opStates;
    if (!opStates) return;

    opStates.push(opstate);
    this.persist();
  }

  public getFlowState(id: string): FlowState {
    return this.db.data.flows[id]?.state;
  }

  public updateflowState(id: string, updatedFields: Partial<FlowState>): void {
    const state = this.db.data.flows[id]?.state;
    if (!state) return;

    Object.assign(state, updatedFields);
    this.persist();
  }

  public updateflowStateSecret(
    id: string,
    updatedFields: { [key: string]: any },
  ): void {
    const state = this.db.data.flows[id]?.state;
    if (!state) return;

    state.secrets = { ...state.secrets, ...updatedFields };
    this.persist();
  }

  public getFlowSecret(id: string, key: string): any | undefined {
    const secrets = this.db.data.flows[id]?.state?.secrets ?? {};
    return secrets[key];
  }

  public updateflowStateError(
    id: string,
    {
      status,
      error,
    }: {
      status?: string;
      error: Error | unknown;
    },
  ): void {
    if (!this.db.data.flows[id]?.state)
      throw new Error('Failed to find flow state.');

    if (status) {
      this.db.data.flows[id].state.status = status;
    }

    if (!this.db.data.flows[id].state.errors) {
      this.db.data.flows[id].state.errors = [];
    }

    (this.db.data.flows[id].state.errors as any[]).push(
      error instanceof Error ? error.message : error,
    );

    this.persist();
  }

  /** Undefined once the flow is gone: container handlers outlive it. */
  private opStateFor(id: string, opIndex: number): OpState | undefined {
    return this.db.data.flows[id]?.state?.opStates?.[opIndex];
  }

  /** The diagnostics, filled in for an op state stored without them. */
  private diagnosticsFor(opState: OpState): OpState['diagnostics'] {
    const reason = opState.diagnostics?.reason ?? {
      hostShutDown: false,
      jobStopped: false,
      jobExpired: false,
    };

    opState.diagnostics = { ...opState.diagnostics, reason };
    return opState.diagnostics;
  }

  public getOpState(id: string, index: number): OpState | undefined {
    return this.opStateFor(id, index);
  }

  public updateOpState(
    id: string,
    opIndex: number,
    updatedFields: Partial<OpState>,
  ): void {
    const opState = this.opStateFor(id, opIndex);
    if (!opState) return;

    Object.assign(opState, updatedFields);
    this.persist();
  }

  public updateOpStateExitCode(
    id: string,
    opIndex: number,
    exitCode: number,
  ): void {
    const opState = this.opStateFor(id, opIndex);
    if (!opState) return;

    opState.exitCode = exitCode;
    this.persist();
  }

  public updateOpStateLogs(id: string, opIndex: number, log: any): void {
    const opState = this.opStateFor(id, opIndex);
    if (!opState) return;

    const logs = opState.logs;

    if (!logs) {
      opState.logs = [log];
    } else {
      // Trim if already at max capacity
      if (logs.length >= MAX_LOGS) {
        logs.shift(); // Remove the oldest log
      }
      logs.push(log);
    }

    this.persist();
  }

  public setOpStateDiagnosticsReason(
    id: string,
    opIndex: number,
    reason: Partial<OpState['diagnostics']['reason']>,
  ): void {
    const opState = this.opStateFor(id, opIndex);
    if (!opState) return;

    const diagnostics = this.diagnosticsFor(opState);

    diagnostics.reason = { ...diagnostics.reason, ...reason };
    this.persist();
  }

  public setOpStateDiagnosticsState(
    id: string,
    opIndex: number,
    state: OpState['diagnostics']['state'],
  ): void {
    const opState = this.opStateFor(id, opIndex);
    if (!opState) return;

    this.diagnosticsFor(opState).state = state;
    this.persist();
  }

  public updateOpStateError(
    id: string,
    opIndex: number,
    error: {
      event: string;
      message: string;
      code?: number;
    },
  ): void {
    const opState = this.opStateFor(id, opIndex);
    if (!opState) return;

    opState.errors ??= [];
    opState.errors.push(error);
    this.persist();
  }

  public updateNodeInfo(updatedFields: Partial<NodeDb['info']>): void {
    Object.assign(this.db.data.info, updatedFields);
    this.persist();
  }

  public getNodeInfo(): NodeDb['info'] {
    return this.db.data.info;
  }

  public getImagesResources(): { [key: string]: ResourceHistory } {
    return this.db.data.resources.images;
  }

  public getImageResource(image: string): ResourceHistory {
    return this.db.data.resources.images[image];
  }

  public createImageResource(image: string, fields: ResourceHistory): void {
    this.db.data.resources.images[image] = fields;
    this.persist();
  }

  public updateImageResource(
    image: string,
    updatedFields: Partial<ResourceHistory> | ResourceHistory,
  ): void {
    if (!this.db.data.resources.images[image]) {
      this.createImageResource(image, updatedFields as ResourceHistory);
    }
    Object.assign(this.db.data.resources.images[image], updatedFields);
    this.persist();
  }

  public deleteImageResource(image: string): void {
    delete this.db.data.resources.images[image];
    this.persist();
  }

  public getVolumesResources(): { [key: string]: VolumeResource } {
    return this.db.data.resources.volumes;
  }

  public getVolumeResource(volume: string): VolumeResource {
    return this.db.data.resources.volumes[volume];
  }

  public createVolumeResource(volume: string, fields: VolumeResource): void {
    this.db.data.resources.volumes[volume] = fields;
    this.persist();
  }

  public updateVolumeResource(
    volume: string,
    updatedFields: Partial<VolumeResource> | VolumeResource,
  ): void {
    if (!this.db.data.resources.volumes[volume]) {
      this.createVolumeResource(volume, updatedFields as VolumeResource);
    }
    Object.assign(this.db.data.resources.volumes[volume], updatedFields);
    this.persist();
  }

  public deleteVolumeResource(volume: string): void {
    delete this.db.data.resources.volumes[volume];
    this.persist();
  }

  public displayLog(log: string) {
    return log;
  }

  public getFlowOperationName(id: string, index: number): string {
    if (this.db.data.flows[id]) {
      return this.db.data.flows[id].jobDefinition.ops[index].id;
    }

    return 'null';
  }
}
