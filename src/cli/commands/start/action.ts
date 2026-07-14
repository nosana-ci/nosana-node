import 'rpc-websockets/dist/lib/client.js';
import chalk from 'chalk';
import NodeManager from '../../../NodeManager/index.js';

const RETEST_BUFFER_S = 60;

export async function startNode(
  market: string,
  options: {
    [key: string]: any;
  },
): Promise<void> {
  options.provider = process.argv.some(arg => arg === '--docker') ? 'docker' : 'podman';

  const nodeManager = new NodeManager(options);

  while (true) {
    try {
      await nodeManager.init();
      await nodeManager.start(market);
    } catch (error: any) {
      if (error.name === 'WSLBlockedError') {
        await nodeManager.stop();
        process.exit(1);
      }

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
      console.error('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.error('Get support in our Discord Server. Join:');
      console.error('https://nosana.com/discord');
      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      if (error.name == 'NodeAlreadyActiveError') {
        process.exit();
      }

      if (error.name === 'NodeNotQualifiedError' && error.nextTestAt) {
        const waitSeconds =
          Math.ceil((error.nextTestAt.getTime() - Date.now()) / 1000) +
          RETEST_BUFFER_S;

        console.log(
          chalk.yellow(
            `Node will automatically retry at ${error.nextTestAt.toISOString()} (in ~${Math.ceil(waitSeconds / 60)} minutes).`,
          ),
        );

        try {
          await nodeManager.clean();
        } catch (error) { }

        await nodeManager.delay(waitSeconds);
        continue;
      }

      if (nodeManager.inJobLoop) {
        try {
          await nodeManager.clean();
        } catch (error) { }

        await nodeManager.delay(60);
        continue;
      } else {
        await nodeManager.error();
        await nodeManager.stop();
        process.exit();
      }
    }
  }
}
