import chalk from 'chalk';

import { pkg } from '../static/index.js';
import { requestExit } from '../exitCodes.js';
import { fetchDistTags } from './registry.js';

function requiresNewVersion(required: string, current: string): boolean {
  return parseInt(required) > parseInt(current);
}

function exitCleanly(
  currentVersion: string,
  latestVersion: string,
  inJobLoop: boolean,
): Promise<never> {
  console.log(
    chalk.red(
      `You are currently running Nosana CLI version ${currentVersion}. Version ${latestVersion} has been released, please update your CLI to the latest version using npm install ${pkg.name}.`,
    ),
  );
  return requestExit({
    type: 'update',
    inJobLoop,
    requestedVersion: latestVersion,
  });
}

/** @param inJobLoop the process that replaces this one stays in the job loop. */
export async function validateCLIVersion(inJobLoop = false) {
  // The version the wrapper was told to seed with, for exercising the update
  // cycle: let it reach the job loop, whose check still runs and requests the
  // update from there. The version installed then no longer matches, so its
  // startup check runs as normal.
  if (!inJobLoop && pkg.version === process.env.NOSANA_NODE_INITIAL_VERSION) {
    console.warn(
      chalk.yellow(
        `Running seeded version ${pkg.version}, deferring the version check to the job loop`,
      ),
    );
    return;
  }

  try {
    const [current_major, current_minor, current_patch] =
      pkg.version.split('.');
    if (
      parseInt(current_major) === 0 &&
      parseInt(current_minor) === 0 &&
      parseInt(current_patch) === 0
    ) {
      console.warn(chalk.yellow('Running in dev mode, skipping version check'));
      return;
    }

    const distTags = await fetchDistTags(pkg.name);
    const distTag = pkg.version.includes('-rc') ? 'next' : 'latest';
    const registryLatestVersion = distTags?.[distTag];

    if (!registryLatestVersion || typeof registryLatestVersion !== 'string') {
      throw new Error('Could not retrieve valid package information from npm');
    }

    const [required_major, required_minor, required_patch] =
      registryLatestVersion.split('.');

    if (parseInt(required_major) === parseInt(current_major)) {
      if (parseInt(required_minor) === parseInt(current_minor)) {
        if (requiresNewVersion(required_patch, current_patch)) {
          await exitCleanly(pkg.version, registryLatestVersion, inJobLoop);
        }
      } else {
        if (requiresNewVersion(required_minor, current_minor)) {
          await exitCleanly(pkg.version, registryLatestVersion, inJobLoop);
        }
      }
    } else {
      if (requiresNewVersion(required_major, current_major)) {
        await exitCleanly(pkg.version, registryLatestVersion, inJobLoop);
      }
    }
  } catch (error: any) {
    console.log(
      `${chalk.red(
        "Failed to fetch CLI's minimum required version.",
      )}\n${error}`,
    );
  }
}
