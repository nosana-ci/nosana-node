import type { Middleware } from "openapi-fetch";

import { getSDK } from "../sdk/index.js";

export const authMiddleware: Middleware = {
  onRequest: async ({ request }) => {
    const sdk = getSDK();
    request.headers.set(
      "Authorization",
      await sdk.authorization.generate(sdk.solana.wallet.publicKey.toString(), {
        includeTime: true,
      })
    );
    return request;
  },
};
