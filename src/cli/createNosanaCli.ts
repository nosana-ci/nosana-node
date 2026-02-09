import { Command, Option } from 'commander';
import { nodeCommand } from './node/index.js';
import { addressCommand } from './address/command.js';
import { OUTPUT_EVENTS } from '../output-formatter/outputEvents.js';
import { outputFormatArgumentParser } from '../output-formatter/outputFormatArgumentParser.js';
import { outputFormatSelector } from '../output-formatter/outputFormatSelector.js';
import { setSDK } from '../NodeManager/sdk/index.js';
import { configs } from '../NodeManager/configs/configs.js';
import { NodeConfigsSingleton } from '../NodeManager/configs/NodeConfigs.js';

export const createNosanaCLI = (version: string) =>
  new Command()
    .name('nosana-node')
    .description('Nosana Node')
    .version(version)
    .configureHelp({ showGlobalOptions: true })
    .hook('preSubcommand', async (_, actionCommand) => {
      outputFormatSelector(
        outputFormatArgumentParser(actionCommand.parent?.args ?? []),
      ).output(OUTPUT_EVENTS.OUTPUT_HEADER_LOGO, { text: 'Nosana' });
    })
    .hook('preAction', async (command, actionCommand) => {
      const opts = actionCommand.optsWithGlobals();
      NodeConfigsSingleton.getInstance(opts);
      let market = opts.market;
      if (opts.network || opts.wallet) {
        await setSDK(
          opts.network,
          opts.rpc,
          market,
          opts.wallet,
          actionCommand.opts(),
        );
      }

      const isNodeRun = command.args[0] === 'node' && command.args[1] === 'run';

      configs({ ...opts, isNodeRun });
    })
    .addOption(
      new Option('--log <logLevel>', 'Log level')
        .default('debug')
        .choices(['info', 'none', 'debug', 'trace']),
    )
    .addCommand(nodeCommand)
    .addCommand(addressCommand)
