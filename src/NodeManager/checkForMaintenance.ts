import chalk from "chalk";

import {
  getMaintenanceStatus,
  waitForMaintenance,
  type MaintenanceResponse,
} from "./clients/maintenanceState.js";
import { sleep } from "./utils/utils.js";
import { validateCLIVersion } from "../version/index.js";

const NPM_POLL_INTERVAL_S = 5 * 60;

function displayUpcomingMaintenanceNotice(status: MaintenanceResponse): void {
  console.log("");
  console.log(chalk.bgBlue.white.bold(" 🛠  SCHEDULED MAINTENANCE "));
  console.log("");
  if (status.startsAt) {
    console.log(chalk.cyan(`• ${chalk.bold("Starts:")} ${status.startsAt}`));
  }
  if (status.expectedEndAt) {
    console.log(
      chalk.cyan(`• ${chalk.bold("Expected end:")} ${status.expectedEndAt}`)
    );
  }
  if (status.reason) {
    console.log(chalk.cyan(`• ${chalk.bold("Reason:")} ${status.reason}`));
  }
  console.log("");
}

export async function checkForMaintenance() {
  const status = await getMaintenanceStatus();
  if (!status?.maintenance) {
    if (status?.startsAt || status?.expectedEndAt || status?.reason) {
      displayUpcomingMaintenanceNotice(status);
    }
    return;
  }

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
