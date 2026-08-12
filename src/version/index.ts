import chalk from 'chalk';

import { pkg } from '../static/index.js';
import { EXIT_CODES } from '../exitCodes.js';

function requiresNewVersion(required: string, current: string): boolean {
  return parseInt(required) > parseInt(current);
}

function exitCleanly(
  currentVersion: string,
  latestVersion: string,
  inJobLoop: boolean,
) {
  console.log(
    chalk.red(
      `You are currently running Nosana CLI version ${currentVersion}. Version ${latestVersion} has been released, please update your CLI to the latest version using npm install ${pkg.name}.`,
    ),
  );
  process.exit(inJobLoop ? EXIT_CODES.UPDATE_IN_JOB_LOOP : EXIT_CODES.UPDATE);
}

/** @param inJobLoop the process that replaces this one stays in the job loop. */
export async function validateCLIVersion(inJobLoop = false) {
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

    const packageData = await fetch(`https://registry.npmjs.com/${pkg.name}`);
    const packageJSON = await packageData.json();
    const distTag = pkg.version.includes('-rc') ? 'next' : 'latest';
    const registryLatestVersion = packageJSON['dist-tags']?.[distTag];

    if (!registryLatestVersion || typeof registryLatestVersion !== 'string') {
      throw new Error('Could not retrieve valid package information from npm');
    }

    const [required_major, required_minor, required_patch] =
      registryLatestVersion.split('.');

    if (parseInt(required_major) === parseInt(current_major)) {
      if (parseInt(required_minor) === parseInt(current_minor)) {
        if (requiresNewVersion(required_patch, current_patch)) {
          exitCleanly(pkg.version, registryLatestVersion, inJobLoop);
        }
      } else {
        if (requiresNewVersion(required_minor, current_minor)) {
          exitCleanly(pkg.version, registryLatestVersion, inJobLoop);
        }
      }
    } else {
      if (requiresNewVersion(required_major, current_major)) {
        exitCleanly(pkg.version, registryLatestVersion, inJobLoop);
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
