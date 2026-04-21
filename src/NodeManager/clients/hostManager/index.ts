import createClient from 'openapi-fetch';

import { paths } from './schema.js';
import { getSDK } from '../../sdk/index.js';
import { configs } from '../../configs/configs.js';

import type { AuthenticatedClient } from '../types.utils.js';

export type HostManagerClient = AuthenticatedClient<paths>;

let instance: HostManagerClient | undefined = undefined;

export const hostManagerClientSelector = (): HostManagerClient => {
  if (!instance) {
    const sdk = getSDK();
    const address = sdk.solana.provider!.wallet.publicKey.toString();

    instance = createClient<paths>({
      baseUrl: configs().hostManagerBaseUrl,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    instance.use({
      async onRequest({ request }) {
        const authHeader = await sdk.authorization.generate(address);
        request.headers.set('Authorization', authHeader);
      }
    });
  }

  return instance;
};
