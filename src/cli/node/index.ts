import { Command, program } from 'commander';

import { runNodeCommand } from './run/command.js';
import { startNodeCommand } from './start/command.js';
import { nodePruneCommand } from './prune/command.js';

export * from './run/command.js';
export * from './start/command.js';
export * from './prune/command.js';

export const nodeCommand: Command = program
  .command('node')
  .addCommand(nodePruneCommand)
  .addCommand(runNodeCommand)
  .addCommand(startNodeCommand)
