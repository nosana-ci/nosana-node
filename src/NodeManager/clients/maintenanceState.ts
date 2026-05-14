import chalk from "chalk";

import { configs } from "../configs/configs.js";
import { consoleLogging } from "../monitoring/log/console/ConsoleLogger.js";
import { sleep } from "../utils/utils.js";

export const MAINTENANCE_BODY = "under maintenance";
const MAINTENANCE_PATH = "/node-under-maintenance";
const POLL_INTERVAL_S = 5;

export type MaintenanceResponse = {
  maintenance: boolean;
  startsAt?: string;
  expectedEndAt?: string;
  reason?: string;
};

let maintenancePromise: Promise<void> | null = null;

const getMaintenanceUrl = (): string => {
  return `${configs().hostManagerBaseUrl}${MAINTENANCE_PATH}`;
};

// Sibling endpoints signal maintenance via 503 + plain text body.
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

export const getMaintenanceStatus = async (): Promise<MaintenanceResponse | null> => {
  try {
    const response = await fetch(getMaintenanceUrl());
    return (await response.json()) as MaintenanceResponse;
  } catch {
    return null;
  }
};

const formatSpinnerText = (body: MaintenanceResponse | null): string => {
  const parts = ["Node under maintenance"];
  if (body?.reason) parts.push(body.reason);
  if (body?.expectedEndAt) parts.push(`ETA ${body.expectedEndAt}`);
  return chalk.yellow(parts.join(" — "));
};

export const waitForMaintenance = (): Promise<void> => {
  if (maintenancePromise) return maintenancePromise;

  const spinner = consoleLogging().spinner;
  const previousText = spinner?.text;
  if (spinner) {
    spinner.text = formatSpinnerText(null);
    if (!spinner.isSpinning) spinner.start();
  }

  maintenancePromise = (async () => {
    for (;;) {
      const body = await getMaintenanceStatus();
      if (body && !body.maintenance) return;
      if (spinner) spinner.text = formatSpinnerText(body);
      await sleep(POLL_INTERVAL_S);
    }
  })().finally(() => {
    if (spinner && previousText !== undefined) spinner.text = previousText;
    maintenancePromise = null;
  });

  return maintenancePromise;
};
