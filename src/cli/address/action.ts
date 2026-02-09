import { Command } from 'commander';
import { type Client } from '@nosana/sdk';

import { getSDK } from '../../NodeManager/sdk/index.js';

export async function getAddress(
  options: {
    [key: string]: any;
  },
  cmd: Command,
) {
  const nosana: Client = getSDK();
}
