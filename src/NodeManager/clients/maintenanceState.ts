import chalk from "chalk";

import { configs } from "../configs/configs.js";
import { consoleLogging } from "../monitoring/log/console/ConsoleLogger.js";
import { sleep } from "../utils/utils.js";

export const MAINTENANCE_BODY = "under maintenance";
const MAINTENANCE_PATH = "/node-under-maintenance";
const MAINTENANCE_TEXT = chalk.yellow("Node under maintenance");
const POLL_INTERVAL_S = 5;

let maintenancePromise: Promise<void> | null = null;

const getMaintenanceUrl = (): string => {
  return `${configs().hostManagerBaseUrl}${MAINTENANCE_PATH}`;
};

export const isMaintenanceResponse = async (
  response: Response
): Promise<boolean> => {
  if (response.status !== 503) return false;

  try {
    const text = await response.clone().text();
    return text.trim().toLowerCase() === MAINTENANCE_BODY;
  } catch {
    return false;
  }
};

export const isMaintenanceActive = async (): Promise<boolean> => {
  try {
    const response = await fetch(getMaintenanceUrl());
    return !response.ok;
  } catch {
    return false;
  }
};

const enterMaintenanceSpinner = (): string | undefined => {
  const spinner = consoleLogging().spinner;
  if (!spinner) return undefined;

  const previous = spinner.text;
  spinner.text = MAINTENANCE_TEXT;
  if (!spinner.isSpinning) spinner.start();
  return previous;
};

const exitMaintenanceSpinner = (previous: string | undefined): void => {
  const spinner = consoleLogging().spinner;
  if (!spinner) return;

  if (previous !== undefined) {
    spinner.text = previous;
  }
};

export const waitForMaintenance = (): Promise<void> => {
  if (maintenancePromise) {
    return maintenancePromise;
  }

  const previousSpinnerText = enterMaintenanceSpinner();
  const url = getMaintenanceUrl();

  maintenancePromise = (async () => {
    for (;;) {
      try {
        const response = await fetch(url);
        if (response.ok) {
          return;
        }
      } catch {
        // Network errors keep us polling.
      }
      await sleep(POLL_INTERVAL_S);
    }
  })().finally(() => {
    exitMaintenanceSpinner(previousSpinnerText);
    maintenancePromise = null;
  });

  return maintenancePromise;
};
