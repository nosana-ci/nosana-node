import { Command, Option } from 'commander';

import { startNode } from './action.js';
import {
  networkOption,
  portOption,
  rpcOption,
  walletOption,
  verboseOption,
  gpuOption,
  teeRuntimeOption,
} from '../sharedOptions/index.js';

export * from './action.js';

export const startNodeCommand = new Command('start')
  .description('Start Nosana Node')
  .argument('[market]', 'market address')
  .addOption(networkOption)
  .addOption(rpcOption)
  .addOption(walletOption)
  .addOption(
    new Option(
      '--docker, --podman <URI>',
      'Podman/Docker connection URI',
    ).default('~/.nosana/podman/podman.sock'),
  )
  .addOption(
    new Option(
      '-c, --config <path>',
      'Config path (to store the flows database and other config)',
    ).default('~/.nosana/'),
  )
  .addOption(teeRuntimeOption)
  .addOption(gpuOption)
  .addOption(portOption)
  .addOption(verboseOption)
  .action(startNode);
