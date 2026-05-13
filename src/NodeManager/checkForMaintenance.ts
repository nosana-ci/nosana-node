import {
  isMaintenanceActive,
  waitForMaintenance,
} from "./client/maintenanceState.js";
import { sleep } from "./utils/utils.js";
import { validateCLIVersion } from "../version/index.js";

const NPM_POLL_INTERVAL_S = 5 * 60;

export async function checkForMaintenance() {
  if (!(await isMaintenanceActive())) return;

  // Re-poll npm during the maintenance window so a published fix triggers
  // a wrapper restart instead of resuming on the stale version.
  const maintenanceFinished = waitForMaintenance().catch(() => undefined);
  let cleared = false;
  maintenanceFinished.then(() => {
    cleared = true;
  });

  while (!cleared) {
    await validateCLIVersion();
    await Promise.race([sleep(NPM_POLL_INTERVAL_S), maintenanceFinished]);
  }
}
