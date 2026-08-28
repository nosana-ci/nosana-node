import {
  createHash,
  ExposedPort,
  Flow,
  getExposePorts,
  isOpExposed,
  Operation,
  OperationArgsMap,
  OperationType,
  Ops,
  Resource,
} from '@nosana/sdk';
import EventEmitter from 'events';
import Dockerode from 'dockerode';

import { configs } from '../configs/configs.js';
import { NodeConfigsSingleton } from '../configs/NodeConfigs.js';
import { NodeRepository } from '../repository/NodeRepository.js';
import {
  ExposedPortHealthCheck,
  RestartableHealthCheck,
} from './ExposedPortHealthCheck.js';
import { s3HelperImage } from '../node/resource/definition/index.js';
import { ResourceManager } from '../node/resource/resourceManager.js';
import { applyLoggingProxyToClass } from '../monitoring/proxy/loggingProxy.js';
import { promiseTimeoutWrapper } from '../utils/timeoutPromiseWrapper.js';
import { liveAbortSignal } from '../utils/liveAbortSignal.js';
import { ContainerOrchestrationInterface, RunContainerArgs } from './containerOrchestration/interface.js';
import {
  generateProxies,
  generateUrlSecretObject,
} from '../utils/expose-util.js';
import { ContainerStateManager } from './ContainerStateManager.js';

export class Provider {
  private readonly frpcImage = configs().frp.containerImage;
  private proxyStartupAbortController: AbortController | undefined = undefined;
  constructor(
    public containerOrchestration: ContainerOrchestrationInterface,
    private repository: NodeRepository,
    private resourceManager: ResourceManager,
  ) {
    applyLoggingProxyToClass(this);
  }

  public async hasTrustedExecutionEnvCapability(): Promise<boolean> {
    return this.containerOrchestration.teeRuntime !== undefined;
  }

  public async stopReverseProxyApi(address: string): Promise<boolean> {
    const frpc_name = `frpc-api-${address}`;
    const networkName = `api-${address}`;

    if (this.proxyStartupAbortController instanceof AbortController) {
      this.proxyStartupAbortController.abort();
    }

    try {
      // Check if the frpc container exists and stop/delete it
      const doesFrpcExist =
        await this.containerOrchestration.doesContainerExist(frpc_name);
      if (doesFrpcExist) {
        await this.containerOrchestration.stopAndDeleteContainer(frpc_name);
      }

      // check if network then delete
      if (await this.containerOrchestration.hasNetwork(networkName)) {
        await this.containerOrchestration.deleteNetwork(networkName);
      }
    } catch (error) {
      throw error;
    }

    return true;
  }

  // set up reverse proxy api for api handler
  public async setUpReverseProxyApi(
    address: string,
    port: string,
  ): Promise<boolean> {
    try {
      const nodeName = configs().frp.nodeInternalHostName;
      const networkName = `api-${address}`;
      const frpc_name = `frpc-api-${address}`;

      await this.containerOrchestration.createNetwork(networkName);

      const networks: { [key: string]: {} } = {};
      networks[networkName] = {};

      const startup = new AbortController();
      this.proxyStartupAbortController = startup;

      await this.containerOrchestration.pullImage(
        this.frpcImage,
        undefined,
        startup,
      );

      this.resourceManager.images.setImage(this.frpcImage);

      const doesFrpcExist =
        await this.containerOrchestration.doesContainerExist(frpc_name);

      // Stopped while the image was being pulled, so the proxy is not wanted:
      // creating it now would put back what the caller has taken down.
      if (startup.signal.aborted) {
        throw new Error('API proxy setup was stopped');
      }

      if (!doesFrpcExist) {
        await this.containerOrchestration.runFlowContainer(this.frpcImage, {
          name: 'frpc-api-' + address,
          cmd: ['-c', '/etc/frp/frpc.toml'],
          networks,
          requires_network_mode: true,
          restart_policy: 'on-failure',
          env: {
            FRP_SERVER_ADDR: configs().frp.serverAddr,
            FRP_SERVER_PORT: configs().frp.serverPort.toString(),
            FRP_PROXIES: JSON.stringify([
              {
                name: 'API-' + address,
                localIp: nodeName,
                localPorts: port.toString(),
                customDomain: address + '.' + configs().frp.serverAddr,
              },
            ]),
          },
          volumes: [
            {
              name: `frpc-${address}-logs`,
              dest: '/data',
            },
          ],
        });
      } else {
        const hasFrpcExited =
          await this.containerOrchestration.isContainerExited(frpc_name);

        if (hasFrpcExited) {
          await this.containerOrchestration.stopAndDeleteContainer(frpc_name);

          await this.containerOrchestration.runFlowContainer(this.frpcImage, {
            name: 'frpc-api-' + address,
            cmd: ['-c', '/etc/frp/frpc.toml'],
            networks,
            requires_network_mode: true,
            restart_policy: 'on-failure',
            env: {
              FRP_SERVER_ADDR: configs().frp.serverAddr,
              FRP_SERVER_PORT: configs().frp.serverPort.toString(),
              FRP_PROXIES: JSON.stringify([
                {
                  name: 'API-' + address,
                  localIp: nodeName,
                  localPorts: port.toString(),
                  customDomain: address + '.' + configs().frp.serverAddr,
                },
              ]),
            },
            volumes: [
              {
                name: `frpc-${address}-logs`,
                dest: '/data',
              },
            ],
          });
        }
      }
    } catch (error) {
      throw error;
    }
    this.proxyStartupAbortController = undefined;
    return true;
  }

  async taskManagerContainerRunOperation(
    flow: Flow,
    op: Operation<'container/run'>,
    controller: AbortController,
    emitter: EventEmitter,
  ) {
    let stateManager: ContainerStateManager | undefined;
    let exposedPortHealthCheck: ExposedPortHealthCheck | undefined;

    if (controller.signal.aborted) {
      emitter.emit('exit', { exitCode: 0 });
      emitter.emit('end');
      return;
    }

    try {
      emitter.emit('start');
      let frpcContainer;

      // A resumed flow re-runs operations that may already have a container, and
      // the name below is the only handle on it.
      const index = getOpStateIndex(flow.jobDefinition.ops, op.id);
      const name = flow.id + '-' + index;

      // An operation runs the same way whether or not the flow it belongs to has
      // already run, so whatever a previous run left behind under these names is
      // removed rather than resumed from. The runtime refuses to create a
      // container whose name is still taken, and all three are recreated below.
      for (const leftover of [name, `frpc-${name}`, `bridge-${name}`]) {
        if (await this.containerOrchestration.doesContainerExist(leftover)) {
          await this.containerOrchestration.stopAndDeleteContainer(leftover);
        }
      }

        await this.containerOrchestration.pullImage(
          op.args.image,
          op.args.authentication?.docker,
          controller,
        );

        if (!op.args.authentication?.docker) {
          this.resourceManager.images.setImage(op.args.image);
        }

        const volumes = getVolumes(op.args, flow);
        const gpu = getGpu(op.args, flow);
        const entrypoint = getEntrypoint(op.args, flow);
        const work_dir = getWorkingDir(op.args, flow);
        const cmd = parseOpArgsCmd(op.args.cmd);
        const env = {
          ...getGlobalEnv(flow),
          ...op.args.env,
          NOSANA_ID: flow.id,
        };
        const aliases = getAliases(op.args);

        const networks: { [key: string]: {} } = {};
        let idMaps: Map<string, ExposedPort> = new Map();
        const ports = getExposePorts(op);
        // A liveness probe restarts the container under the running op, so the
        // state manager has to know a stop may not be the op finishing.
        const restartsOnUnhealthy = ports.some((port) =>
          port.health_checks?.some(
            (check) => (check as RestartableHealthCheck).restart_on_failure,
          ),
        );
        networks[name] = {};
        await this.containerOrchestration.createNetwork(name, controller);

        if (isOpExposed(op as Operation<'container/run'>)) {
          await this.containerOrchestration.pullImage(
            this.frpcImage,
            undefined,
            controller,
          );

          this.resourceManager.images.setImage(this.frpcImage);

          /**
           * because of the introduction of deployment_id(load balancing key) instead of using flow.id we use deployment_id for more
           * deterministic url generation
           */
          const config = NodeConfigsSingleton.getInstance();
          const isLoadBalanced = !!flow.jobDefinition.deployment_id;
          const deploymentHash = isLoadBalanced
            ? // @ts-ignore
            config.options.isNodeRun
              ? flow.jobDefinition.deployment_id
              : createHash(
                `${flow.jobDefinition.deployment_id}:${flow.project}`,
                45,
              )
            : undefined;

          const { proxies, idMap } = generateProxies(
            flow.id,
            op,
            index,
            ports,
            name,
            op.id,
            deploymentHash,
          );
          idMaps = idMap;
          frpcContainer = await this.containerOrchestration.runFlowContainer(
            this.frpcImage,
            this.generateFrpcContainerConfig(
              name,
              networks,
              flow,
              proxies,
              isLoadBalanced,
              deploymentHash,
            ),
          );
          if (op.args.private) {
            this.repository.updateflowStateSecret(flow.id, {
              [flow.id]: generateUrlSecretObject(idMap, op.id),
              urlmode: 'private',
            });
            emitter.emit('flow:secrets-updated', {
              flowId: flow.id,
              opId: op.id,
            });
          } else {
            const newSecret = generateUrlSecretObject(idMap, op.id);

            const currentSecrets =
              this.repository.getFlowSecret(flow.id, flow.id) || {};
            const mergedSecrets = {
              ...currentSecrets,
              ...newSecret,
            };

            this.repository.updateflowStateSecret(flow.id, {
              [flow.id]: mergedSecrets,
              urlmode: 'public',
            });
            emitter.emit('flow:secrets-updated', {
              flowId: flow.id,
              opId: op.id,
            });
          }
        }

        if (op.args.resources) {
          await this.containerOrchestration.pullImage(
            s3HelperImage,
            undefined,
            controller,
          );
          this.resourceManager.images.setImage(s3HelperImage);

          // transformCollections has already resolved any SpreadMarker objects by this point
          const resourceVolumes = await this.resourceManager.getResourceVolumes(
            (op.args.resources as Resource[]) ?? [],
            controller,
            { id: flow.id, opIndex: index },
          );
          volumes.push(...resourceVolumes);
        }

        // The op only declares that it wants a TEE; the node's configured
        // runtime decides how that is fulfilled.
        const teeRuntime = op.args.trusted_execution_env
          ? this.containerOrchestration.teeRuntime
          : undefined;

        const createContainerOptions: RunContainerArgs = {
          name,
          cmd,
          env,
          networks,
          requires_network_mode: isOpExposed(
            op as Operation<'container/run'>,
          ),
          gpu,
          entrypoint,
          work_dir,
          volumes,
          aliases,
          restart_policy: op.args.restart_policy,
          runtime: teeRuntime,
        };

        if (teeRuntime === 'SEV-SNP') {
          await this.containerOrchestration.pullImage("busybox");
          await this.resourceManager.images.setImage("busybox");

          const bridgeContainer = await this.containerOrchestration.runFlowContainer(
            "busybox",
            {
              name: `bridge-${name}`,
              cmd: ['sleep', 'infinity'],
              aliases: createContainerOptions.aliases
            })

          delete createContainerOptions.aliases;
          createContainerOptions.bind_network_to_container = `container:bridge-${name}`;

          const bridgeInfo = await bridgeContainer.inspect();

          if (bridgeInfo.NetworkSettings?.Networks["NOSANA_GATEWAY"].IPAddress) {
            emitter.emit('setContainerInternalIp', bridgeInfo.NetworkSettings.Networks["NOSANA_GATEWAY"].IPAddress);
          }
        }

        const container = await this.containerOrchestration.runFlowContainer(
          op.args.image ?? flow.jobDefinition.global?.image!,
          createContainerOptions
        );

        // The container is now running (image pull is already done). This is the
        // point the op-execution timeout clock starts from, so pull time isn't
        // counted against it.
        emitter.emit('container:started');

        const startedInfo = await container.inspect();

        emitter.emit('updateOpState', { providerId: container.id });

        if (teeRuntime !== 'SEV-SNP' && startedInfo.NetworkSettings?.Networks["NOSANA_GATEWAY"].IPAddress) {
          emitter.emit('setContainerInternalIp', startedInfo.NetworkSettings.Networks["NOSANA_GATEWAY"].IPAddress);
        }

        stateManager = new ContainerStateManager(
          container,
          controller,
          emitter,
          op.args.restart_policy,
          restartsOnUnhealthy,
        );
        await stateManager.startMonitoring();

        if (isOpExposed(op)) {
          exposedPortHealthCheck = new ExposedPortHealthCheck(
            flow.id,
            frpcContainer as Dockerode.Container,
            emitter,
            name,
            restartsOnUnhealthy
              ? () => stateManager!.restartContainer()
              : undefined,
          );

          exposedPortHealthCheck.addExposedPortsMap(idMaps);
          exposedPortHealthCheck.startServiceExposedUrlHealthCheck();
        } else {
          emitter.emit('healthcheck:startup:success');
        }

        await stateManager.waitForExit();

        // `wait()` reporting the exit and the log stream finishing its final
        // flush are independent; drain the stream before results are read off
        // the logs so the last line (e.g. the op's result) isn't lost.
        await stateManager.waitForLogsDrained();

      const info = await promiseTimeoutWrapper(
        container.inspect({
          abortSignal: liveAbortSignal(controller.signal),
        }),
        360,
        controller,
      );

      emitter.emit('exit', { exitCode: info.State.ExitCode });
    } catch (error) {
      emitter.emit('log', error, 'error');
      emitter.emit('error', error);
    }

    // Clean up resources
    stateManager?.stopMonitoring();
    exposedPortHealthCheck?.stopAllHealthChecks();
    exposedPortHealthCheck = undefined;

    emitter.emit('end');
  }

  public generateFrpcContainerConfig(
    name: string,
    networks: {
      [p: string]: {};
    },
    flow: Flow,
    proxies: any[],
    isLoadBalanced: boolean,
    deploymentHash: string | undefined,
  ) {
    return {
      name: 'frpc-' + name,
      cmd: ['/entrypoint.sh'],
      networks,
      requires_network_mode: true,
      env: {
        FRP_SERVER_ADDR: configs().frp.serverAddr,
        FRP_SERVER_PORT: configs().frp.serverPort.toString(),
        NOSANA_ID: flow.id,
        FRP_PROXIES: JSON.stringify(proxies),
        DEPLOYMENT_ID: flow.jobDefinition.deployment_id ?? '',
        JOB_ID: flow.id,
        ...(isLoadBalanced && {
          FRP_LB_GROUP_KEY: deploymentHash,
        }),
      },
    };
  }

  async taskManagerContainerStopRunOperation(
    flow: Flow,
    op: Operation<'container/run'>,
    emitter?: EventEmitter,
  ): Promise<void> {
    try {
      const index = getOpStateIndex(flow.jobDefinition.ops, op.id);
      const name = flow.id + '-' + index;

      const [opContainer, getSupportContainers] = await Promise.all([
        this.containerOrchestration.getContainerByName(name),
        this.containerOrchestration.getContainersByName([`frpc-${name}`, `bridge-${name}`]),
      ]);

      if (opContainer) {
        const info = await this.containerOrchestration.stopAndDeleteContainer(
          opContainer.id,
        );
        if (info) {
          this.repository.updateOpStateExitCode(
            flow.id,
            index,
            info.State.ExitCode,
          );
          this.repository.setOpStateDiagnosticsState(flow.id, index, {
            ...info.State,
            RestartCount: info.RestartCount,
          });
        }
      }

      if (getSupportContainers) {
        await Promise.all(
          getSupportContainers.map((container) =>
            this.containerOrchestration.stopAndDeleteContainer(container.id)
          )
        );
      }

      await this.containerOrchestration.deleteNetwork(name);

      if (
        (
          flow.jobDefinition.ops[index]
            .args as OperationArgsMap['container/run']
        ).authentication?.docker
      ) {
        await this.containerOrchestration.deleteImage(
          (
            flow.jobDefinition.ops[index]
              .args as OperationArgsMap['container/run']
          ).image,
        );
      }
    } catch (error) {
      emitter?.emit('log', error, 'error');
      throw error;
    }
  }

  /**
   * Runs a full container operation lifecycle:
   * 1. Starts the container, emits lifecycle events, waits for completion or error.
   * 2. Then stops and cleans up the container, network, and associated Docker resources.
   *
   * This function ties together both the **execution** and **cleanup** stages for a containerized operation.
   *
   * The steps are:
   * - Emits 'start' → Pulls container image (if needed) → Creates volume/network (if needed)
   * - Runs container with correct args/env/entrypoint
   * - Follows logs and emits 'log' → Waits for completion → Emits 'exit' or 'error'
   * - Regardless of outcome, cleans up resources (containers, networks, optional image)
   *
   * Emits:
   * - 'start': when the operation begins
   * - 'log': every time stdout/stderr produces output
   * - 'updateOpState': to attach container ID
   * - 'exit': when the operation finishes successfully or with failure
   * - 'error': when something crashes
   * - 'end': always, after cleanup
   *
   * @param flow - The job flow this operation is part of
   * @param op - The specific container operation to run
   * @param controller - AbortController to support cancellation
   * @param emitter - EventEmitter to stream logs and events from the container lifecycle
   */
  async taskManagerContainerStartRunandStopOperation(
    flow: Flow,
    op: Operation<'container/run'>,
    controller: AbortController,
    emitter: EventEmitter,
  ) {
    try {
      await this.taskManagerContainerRunOperation(
        flow,
        op,
        controller,
        emitter,
      );
    } finally {
      await this.taskManagerContainerStopRunOperation(flow, op, emitter);
    }
  }

  async taskManagerVolumeStartRunandStopOperation(
    flow: Flow,
    op: Operation<'container/create-volume'>,
    controller: AbortController,
    emitter: EventEmitter,
  ) {
    await this.taskManagerVolumeCreateOperation(flow, op, controller, emitter);
    /**
     * we don't put the volume stop here because it will delete the volume that
     * might be used by other operations in the group, we will leave that for the
     * final clean up.
     * await this.taskManagerVolumeStopOperation(flow, op, emitter)
     */
  }

  async taskManagerVolumeCreateOperation(
    flow: Flow,
    op: Operation<'container/create-volume'>,
    controller: AbortController,
    emitter: EventEmitter,
  ) {
    if (controller.signal.aborted) {
      emitter.emit('exit', { exitCode: 0 });
      emitter.emit('end');
      return;
    }

    try {
      emitter.emit('start');

      const name = flow.id + '-' + op.args.name;

      const isVolume = await this.containerOrchestration.hasVolume(name);
      if (!isVolume) {
        const volume = await this.containerOrchestration.createVolume(
          name,
          controller,
        );

        emitter.emit('updateOpHost', { name });
        emitter.emit('updateOpState', { providerId: volume.Status });
      }

      emitter.emit('healthcheck:startup:success');

      emitter.emit('exit', { exitCode: 0 });
    } catch (error) {
      emitter.emit('log', error, 'error');
      emitter.emit('error', error);
    }
    emitter.emit('end');
  }

  async taskManagerVolumeStopOperation(
    flow: Flow,
    op: Operation<'container/create-volume'>,
    emitter?: EventEmitter,
  ) {
    try {
      const name = flow.id + '-' + op.args.name;

      const isVolume = await this.containerOrchestration.hasVolume(name);
      if (!isVolume) {
        await this.containerOrchestration.deleteVolume(name);
      }
    } catch (error) {
      emitter?.emit('log', error, 'error');
      throw error;
    }
  }

  public runTaskManagerOperation(
    flow: Flow,
    op: Operation<OperationType>,
    controller: AbortController,
    emitter: EventEmitter,
  ): Promise<void> {
    switch (op.type) {
      case 'container/run':
        return this.taskManagerContainerStartRunandStopOperation(
          flow,
          op as Operation<'container/run'>,
          controller,
          emitter,
        );

      case 'container/create-volume':
        return this.taskManagerVolumeStartRunandStopOperation(
          flow,
          op as Operation<'container/create-volume'>,
          controller,
          emitter,
        );

      default:
        throw new Error(`operation type '${op.type}' not supported`);
    }
  }

  public stopTaskManagerOperation(
    flow: Flow,
    op: Operation<OperationType>,
    emitter?: EventEmitter,
  ): Promise<void> {
    switch (op.type) {
      case 'container/run':
        return this.taskManagerContainerStopRunOperation(
          flow,
          op as Operation<'container/run'>,
          emitter,
        );

      case 'container/create-volume':
        return this.taskManagerVolumeStopOperation(
          flow,
          op as Operation<'container/create-volume'>,
          emitter,
        );

      default:
        throw new Error(`operation type '${op.type}' not supported`);
    }
  }
}

function getOpStateIndex(ops: Ops, opId: string): number {
  const index = ops.findIndex((op) => op.id === opId);

  if (index === -1) {
    throw new Error(`Operation not found for ID: ${opId}`);
  }

  return index;
}

export function parseOpArgsCmd(
  cmd: OperationArgsMap['container/run']['cmd'],
): string[] | undefined {
  if (typeof cmd !== 'string') return cmd;
  return ['/bin/sh', '-c', cmd];
}

function getGlobalEnv(flow: Flow) {
  return flow.jobDefinition.global && flow.jobDefinition.global.env
    ? flow.jobDefinition.global.env
    : {};
}

function getWorkingDir(arg: OperationArgsMap['container/run'], flow: Flow) {
  return arg.work_dir ||
    !flow.jobDefinition.global ||
    !flow.jobDefinition.global.work_dir
    ? arg.work_dir
    : flow.jobDefinition.global.work_dir;
}

function getEntrypoint(arg: OperationArgsMap['container/run'], flow: Flow) {
  return arg.entrypoint ||
    !flow.jobDefinition.global ||
    !flow.jobDefinition.global.entrypoint
    ? arg.entrypoint
    : flow.jobDefinition.global.entrypoint;
}

function getGpu(arg: OperationArgsMap['container/run'], flow: Flow) {
  return (
    arg.gpu || (flow.jobDefinition.global && flow.jobDefinition.global.gpu)
  );
}

function getVolumes(arg: OperationArgsMap['container/run'], flow: Flow) {
  const volumes: { dest: string; name: string; readonly?: boolean }[] = [];

  if (arg.volumes && arg.volumes.length > 0) {
    for (let i = 0; i < arg.volumes.length; i++) {
      const volume = arg.volumes[i];
      volumes.push({
        dest: volume.dest,
        name: flow.id + '-' + volume.name,
      });
    }
  }
  return volumes;
}

function getAliases(args: OperationArgsMap['container/run']) {
  if (!args.aliases) return undefined;
  if (typeof args.aliases === 'string') return args.aliases.split(',');
  return args.aliases;
}
