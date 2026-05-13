import createClient from "openapi-fetch";

import { paths } from "./schema.js";
import { configs } from "../configs/configs.js";
import { maintenanceMiddleware } from "./maintenanceMiddleware.js";
import { authMiddleware } from "./authMiddleware.js";

export type QueryClient = ReturnType<typeof createClient<paths>>;

let baseInstance: QueryClient | undefined;
let authInstance: QueryClient | undefined;

const createInstance = (): QueryClient =>
  createClient<paths>({
    baseUrl: configs().backendUrl?.replace("/api", "") || "",
    headers: {
      "Content-Type": "application/json",
    },
  });

export const clientSelector = (opts?: { withAuth?: boolean }): QueryClient => {
  if (opts?.withAuth) {
    if (!authInstance) {
      authInstance = createInstance();
      authInstance.use(maintenanceMiddleware);
      authInstance.use(authMiddleware);
    }
    return authInstance;
  }

  if (!baseInstance) {
    baseInstance = createInstance();
    baseInstance.use(maintenanceMiddleware);
  }
  return baseInstance;
};
