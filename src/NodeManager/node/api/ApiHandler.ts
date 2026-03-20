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
  verifyBackendSignatureMiddleware,
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
  postNodeValidation,
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
  moveGroupOperationHandler,
  getJobDefinitionRoute,
  getJobInfoRoute,
  getJobStatsRoute,
  getJobStatsStreamRoute,
} from './routes/index.js';
import { NodeAlreadyActiveError } from '../../errors/NodeAlreadyActiveError.js';

export class ApiHandler {
  private api: Express;
  private address: PublicKey;
  private server: Server | null = null;
  private wss: WebSocket.Server | null = null; // WebSocket server
  private eventEmitter = ApiEventEmitter.getInstance();
  private apiCheckInterval: NodeJS.Timeout | null = null;

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

  public async testApiServerOnce(server: string): Promise<boolean> {
    try {
      const response = await fetch(`${server}`);

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
    this.stopApiCheck();
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
    if (!this.apiCheckInterval) {
      this.apiCheckInterval = setInterval(async () => {
        const isAlive = await this.testApiServerOnce(server);

        if (!isAlive) {
          console.log('API proxy is offline, restarting..');
          await this.restartApiProxy();
        }
      }, 60000 * 5); // every 5 minutes
    }
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
    this.api.post(
      '/node/validate',
      verifyBackendSignatureMiddleware,
      postNodeValidation,
    );

    this.api.post('/job/:jobId/job-definition', postJobDefinitionRoute);
    this.api.post('/job/:jobId/group/:group/move', moveGroupOperationHandler);
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
    if (this.apiCheckInterval) {
      clearInterval(this.apiCheckInterval);
      this.apiCheckInterval = null;
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
    await this.stopApiProxy();
    this.stopServerAndWebSocket();
  }
}
