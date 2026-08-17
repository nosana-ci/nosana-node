import cors from 'cors';
import WebSocket from 'ws';
import { Server } from 'http';
import { Client as SDK } from '@nosana/sdk';
import { PublicKey } from '@solana/web3.js';
import express, { Express, NextFunction, Request, Response } from 'express';

import ApiEventEmitter from './ApiEventEmitter.js';
import { configs } from '../../configs/configs.js';
import { sleep } from '../../utils/utils.js';
import { NodeAPIRequest } from './types/index.js';
import { stateStreaming } from '../../monitoring/streaming/StateStreamer.js';
import { applyLoggingProxyToClass } from '../../monitoring/proxy/loggingProxy.js';
import { Provider } from '../../provider/Provider.js';
import { NodeRepository } from '../../repository/NodeRepository.js';

import {
  verifyJobOwnerSignatureMiddleware,
  verifyWSJobOwnerSignatureMiddleware,
  verifyWSMiddleware,
  verifyWSNodeOrJobOwnerSignatureMiddleware,
} from './middlewares/index.js';

import {
  getNodeInfoRoute,
  getJobResultsRoute,
  getServiceUrlRoute,
  postJobDefinitionRoute,
  postServiceStopRoute,
  wssLogRoute,
  wssStatusRoute,
  getCurrentGroupStatusHandler,
  getGroupStatusHandler,
  getOperationsStatusHandler,
  getOperationStatusHandler,
  restartGroupOperationHandler,
  restartOperationHandler,
  stopGroupOperationHandler,
  stopOperationHandler,
  wssTaskManagerLogRoute,
  getJobDefinitionRoute,
  getJobInfoRoute,
  getJobStatsRoute,
  getJobStatsStreamRoute,
} from './routes/index.js';
import { NodeAlreadyActiveError } from '../../errors/NodeAlreadyActiveError.js';
import { reportError } from '../../monitoring/reportError.js';
import { EXIT_CODES } from '../../../exitCodes.js';
import { TaskManagerRegistry } from '../task/TaskManagerRegistry.js';

/** Rebuilds to fail before the process is replaced. */
const MAX_PROXY_RESTART_FAILURES = 3;

const API_CHECK_TIMEOUT_MS = 10 * 1000;

/** Longer than the check: a slow answer means a node is there, not absent. */
const API_TEST_TIMEOUT_MS = 60 * 1000;

const API_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const API_CHECK_MIN_GAP_MS = 30 * 1000;

export class ApiHandler {
  private api: Express;
  private address: PublicKey;
  private server: Server | null = null;
  private wss: WebSocket.Server | null = null; // WebSocket server
  private eventEmitter = ApiEventEmitter.getInstance();
  private apiCheckTimer: NodeJS.Timeout | null = null;
  private failedProxyRestarts = 0;

  constructor(
    private sdk: SDK,
    private repository: NodeRepository,
    private provider: Provider,
    private port: number,
  ) {
    this.address = this.sdk.solana.provider!.wallet.publicKey;
    this.api = express();
    this.api.use(cors());
    this.registerRoutes();

    applyLoggingProxyToClass(this);

    // periodically check if the api server returns a response on / (the response is the address)
    // if not stop the reverse proxy and set it up again
  }

  public async start(): Promise<string> {
    try {
      const server = await this.restartApiProxy();

      return server;
    } catch (error) {
      throw error;
    }
  }

  public async preventMultipleApiStarts() {
    if (
      await this.testApiServerOnce(
        `https://${this.address}.${configs().frp.serverAddr}`,
      )
    ) {
      throw new NodeAlreadyActiveError(this.address.toString());
    }
  }

  public async testApiServerOnce(
    server: string,
    timeoutMs: number = API_TEST_TIMEOUT_MS,
  ): Promise<boolean> {
    try {
      // A tunnel that is down accepts the connection and answers nothing, so
      // without a deadline this waits minutes for the runtime's own.
      const response = await fetch(`${server}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) return false;

      const responseText = await response.json();
      return responseText === this.address.toString();
    } catch {
      return false;
    }
  }

  private async restartApiProxy() {
    await this.stopApiProxy();
    await this.provider.setUpReverseProxyApi(
      this.address.toString(),
      this.port.toString(),
    );

    this.stopServerAndWebSocket();

    const server = `https://${this.address}.${configs().frp.serverAddr}`;

    await sleep(3);

    this.startApiCheck(server);

    await this.listen();
    this.startWebSocketServer();

    return server;
  }

  private async stopApiProxy() {
    await this.provider.stopReverseProxyApi(this.address.toString());
  }

  private async startWebSocketServer() {
    this.wss = new WebSocket.Server({ noServer: true });

    this.server?.on('upgrade', (request, socket, head) => {
      this.wss?.handleUpgrade(request, socket as any, head, (ws) => {
        this.wss?.emit('connection', ws, request);
      });
    });

    this.wss.on('connection', (ws) => {
      let keepAliveInterval: NodeJS.Timeout;
      ws.on('message', async (message) => {
        try {
          const { path, header, body } = JSON.parse(message.toString());

          keepAliveInterval = setInterval(() => {
            ws.ping();
          }, 30000);

          switch (path) {
            case '/log':
              await verifyWSJobOwnerSignatureMiddleware(
                ws,
                header,
                body,
                wssLogRoute,
              );
              break;
            case '/flog':
              await verifyWSJobOwnerSignatureMiddleware(
                ws,
                header,
                body,
                wssTaskManagerLogRoute,
              );
              break;
            case '/status':
              await verifyWSNodeOrJobOwnerSignatureMiddleware(
                ws,
                header,
                body,
                wssStatusRoute,
              );
              break;
            default:
              ws.close(3003, 'Invalid Path');
              break;
          }
        } catch (err) {
          ws.close(1011, 'Internal Server Error');
        }
      });

      ws.on('close', () => {
        if (keepAliveInterval) {
          clearInterval(keepAliveInterval);
        }

        stateStreaming(this.address.toString()).unsubscribe(ws);
      });
    });
  }

  private startApiCheck(server: string) {
    if (!this.apiCheckTimer) {
      this.scheduleApiCheck(server, API_CHECK_INTERVAL_MS);
    }
  }

  /**
   * Check the API, scheduling the next check once this one is done: a rebuild
   * takes as long as an image pull, and two cannot both create the proxy.
   */
  private scheduleApiCheck(server: string, delayMs: number) {
    this.apiCheckTimer = setTimeout(async () => {
      const startedAt = Date.now();

      try {
        const isAlive = await this.testApiServerOnce(
          server,
          API_CHECK_TIMEOUT_MS,
        );

        if (isAlive) {
          this.failedProxyRestarts = 0;
          return;
        }

        // Stopped while this check waited, so the proxy is not wanted.
        if (!this.apiCheckTimer) return;

        console.log('API proxy is offline, restarting..');
        await this.restartApiProxy();
        this.failedProxyRestarts = 0;
      } catch (error) {
        // Nothing awaits this check, so a throw would leave unhandled.
        const message =
          (error as { message?: string })?.message ?? String(error);
        const description = `Could not restart the API proxy: ${message}. The node is not reachable until it is rebuilt.`;

        console.error(description);

        void reportError({
          error_type: 'apiProxyRestartFailure',
          error_name: (error as Error)?.name ?? 'Error',
          error_message: description,
          error_stack: (error as Error)?.stack ?? '',
        });

        this.endNodeIfProxyIsLost(error);
      } finally {
        // Cleared by stopApiCheck, which is how a stopped API stays stopped.
        // The delay is what is left of the interval, so a long rebuild does not
        // push the next check out.
        if (this.apiCheckTimer) {
          this.scheduleApiCheck(
            server,
            Math.max(
              API_CHECK_INTERVAL_MS - (Date.now() - startedAt),
              API_CHECK_MIN_GAP_MS,
            ),
          );
        }
      }
    }, delayMs);
  }

  /**
   * End the process once the proxy counts as lost, so a fresh one can build it:
   * nothing else in this process rebuilds it. A job in flight outranks that,
   * since resuming a flow runs its operations again, and an unreachable registry
   * is not something a new process fixes.
   */
  private endNodeIfProxyIsLost(error: unknown): void {
    if ((error as { eventType?: string })?.eventType === 'image-pull-error') {
      return;
    }

    this.failedProxyRestarts++;

    if (this.failedProxyRestarts < MAX_PROXY_RESTART_FAILURES) return;

    if (TaskManagerRegistry.getInstance().size() > 0) {
      console.error(
        'The API proxy could not be rebuilt, waiting for the running job to finish.',
      );
      return;
    }

    console.error('The API proxy could not be rebuilt, restarting the node.');
    process.exit(EXIT_CODES.RESTART);
  }

  private async registerRoutes() {
    // Attach require objects to routes
    this.api.use((req: NodeAPIRequest, _: Response, next: NextFunction) => {
      req.repository = this.repository;
      req.provider = this.provider;
      req.eventEmitter = this.eventEmitter;
      req.address = this.address;
      next();
    });

    this.api.use(express.json());

    this.api.use('/job/:jobId/*', verifyJobOwnerSignatureMiddleware);

    // GET Routes
    this.api.get('/node/info', getNodeInfoRoute);

    this.api.get('/', (_: Request, res: Response) => res.send(this.address));
    this.api.get('/job/:jobId/info', getJobInfoRoute);
    this.api.get('/job/:jobId/results', getJobResultsRoute);
    this.api.get('/job/:jobId/job-definition', getJobDefinitionRoute);
    this.api.get('/job/:jobId/ops', getOperationsStatusHandler);
    this.api.get('/job/:jobId/ops/:opId', getOperationStatusHandler);
    this.api.get('/job/:jobId/group/current', getCurrentGroupStatusHandler);
    this.api.get('/job/:jobId/group/:group', getGroupStatusHandler);
    this.api.get('/job/:jobId/endpoints', getServiceUrlRoute);
    this.api.get('/job/:jobId/stats', getJobStatsRoute);
    this.api.get('/job/:jobId/stats/stream', getJobStatsStreamRoute);

    // POST Routes
    this.api.post('/job/:jobId/job-definition', postJobDefinitionRoute);
    this.api.post(
      '/job/:jobId/group/:group/operation/:opId/restart',
      restartOperationHandler,
    );
    this.api.post(
      '/job/:jobId/group/:group/restart',
      restartGroupOperationHandler,
    );
    this.api.post(
      '/job/:jobId/group/:group/operation/:opId/stop',
      stopOperationHandler,
    );
    this.api.post('/job/:jobId/group/:group/stop', stopGroupOperationHandler);
    this.api.post('/job/:jobId/stop', postServiceStopRoute);
  }

  private async listen(): Promise<number> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    return new Promise<number>((resolve, reject) => {
      this.server = this.api.listen(this.port, () => {
        resolve(this.port);
      });

      this.server.on('error', (err: Error) => {
        reject(err);
      });
    });
  }

  private stopApiCheck() {
    if (this.apiCheckTimer) {
      clearTimeout(this.apiCheckTimer);
      this.apiCheckTimer = null;
    }
  }

  public stopServerAndWebSocket() {
    if (this.server) {
      this.server.close();
    }
    if (this.wss) {
      this.wss.close();
    }
  }

  public async stop() {
    this.stopApiCheck();
    await this.stopApiProxy();
    this.stopServerAndWebSocket();
  }
}
