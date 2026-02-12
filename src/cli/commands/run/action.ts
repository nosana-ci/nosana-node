import util from 'util';
import { createHash, JobDefinition } from '@nosana/sdk';

import { Provider } from '../../../NodeManager/provider/Provider.js';
import { ResourceManager } from '../../../NodeManager/node/resource/resourceManager.js';
import { NodeRepository } from '../../../NodeManager/repository/NodeRepository.js';
import { DB } from '../../../NodeManager/db/index.js';
import { selectContainerOrchestrationProvider } from '../../../NodeManager/provider/containerOrchestration/selectContainerOrchestration.js';
import { log } from '../../../NodeManager/monitoring/log/NodeLog.js';
import { ConsoleLogger } from '../../../NodeManager/monitoring/log/console/ConsoleLogger.js';
import TaskManager, {
  StopReasons,
} from '../../../NodeManager/node/task/TaskManager.js';
import { loadJobDefinitionFromFile } from '../../../NodeManager/utils/jobDefinitionParser.js';
import { generateDeploymentEndpointsTable } from './generateDeploymentEndpointsTable.js';
import { generateRandomId } from '../../../NodeManager/node/utils/generateRandomId.js';
import { getSDK } from '../../../NodeManager/sdk/index.js';
import { createLoggingProxy } from '../../../NodeManager/monitoring/proxy/loggingProxy.js';

export async function runJob(
  jobDefinitionFile: string,
  options: {
    [key: string]: any;
  },
) {
  options.provider = process.argv.some(arg => arg === '--docker') ? 'docker' : 'podman';

  try {
    const sdk = getSDK();
    const jobDefinition = await resolveJobDefinition(
      options,
      jobDefinitionFile,
    );

    if (jobDefinition.deployment_id) {
      jobDefinition.deployment_id = createHash(
        `local-${jobDefinition.deployment_id
        }:${sdk.solana.wallet.publicKey.toString()}`,
        45,
      );

      generateDeploymentEndpointsTable(jobDefinition);
    }

    /**
     * set up log listening, any instance can listen to log produces from the node
     * the logs are produces from the log proxy
     */
    log();

    const db = new DB(options.config).db;
    const repository = createLoggingProxy(new NodeRepository(db));

    const containerOrchestration = selectContainerOrchestrationProvider(
      options.provider,
      options.podman,
      options.gpu,
    );

    const resourceManager = new ResourceManager(
      containerOrchestration,
      repository,
    );

    const provider = new Provider(
      containerOrchestration,
      repository,
      resourceManager,
    );

    const logger = new ConsoleLogger(false);
    logger.addObserver();

    const job = generateRandomId(32);

    const tm = new TaskManager(
      provider,
      repository,
      job,
      sdk.solana.wallet.publicKey.toString(),
      jobDefinition,
    );
    tm.bootstrap();

    const exitHandler = async () => {
      await tm.stop(StopReasons.STOPPED);
    };

    process.on('SIGINT', exitHandler); // Handle Ctrl+C
    process.on('SIGTERM', exitHandler); // Handle termination signals

    await tm.start();

    const result = repository.getFlowState(job);

    console.log(
      '\nResult: ',
      util.inspect(result, { showHidden: false, depth: null, colors: true }),
    );
  } catch (error: any) {
    const formattedError = `
      ========== ERROR ==========
      Timestamp: ${new Date().toISOString()}
      Error Name: ${error.name || 'Unknown Error'}
      Message: ${error.message || 'No message available'}${options.verbose
        ? `
      Trace: ${error.stack ?? error.trace}`
        : ''
      }
      ============================
      `;

    console.error(formattedError);
  }
  process.exit();
}

async function resolveJobDefinition(
  options: {
    [key: string]: any;
  },
  jobDefinitionFile: string,
): Promise<JobDefinition> {
  let jobDefinition: JobDefinition;

  if (options.url) {
    try {
      const data = await fetch(options.url);
      const json = await data.json();
      jobDefinition = json;
    } catch (e) {
      throw new Error(`Failed to fetch remote job flow.\n${e}`);
    }
  } else {
    if (!jobDefinitionFile) {
      throw new Error('Missing Job Definition Argument');
    }
    jobDefinition = loadJobDefinitionFromFile(jobDefinitionFile);
  }

  return jobDefinition;
}
