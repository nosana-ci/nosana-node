import type { Middleware } from "openapi-fetch";

import {
  isMaintenanceResponse,
  waitForMaintenance,
} from "./maintenanceState.js";

export const maintenanceMiddleware: Middleware = {
  onResponse: async ({ response, request, options }) => {
    let current = response;

    while (await isMaintenanceResponse(current)) {
      await waitForMaintenance();
      current = await options.fetch(request.clone());
    }

    return current === response ? undefined : current;
  },
};
