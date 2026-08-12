import chalk from 'chalk';
import { exec, spawn } from 'child_process';
import ora from 'ora';

type SpawnParameters = Parameters<typeof spawn>;

/**
 * Codes the node uses to ask for another process; any other code ends this
 * wrapper too. Keep in sync with `src/exitCodes.ts`.
 */
const UPDATE_EXIT_CODE = 129;
const UPDATE_IN_JOB_LOOP_EXIT_CODE = 76;
const RESTART_EXIT_CODE = 75;

const UPDATE_CODES = [UPDATE_EXIT_CODE, UPDATE_IN_JOB_LOOP_EXIT_CODE];
const RESPAWN_CODES = [...UPDATE_CODES, RESTART_EXIT_CODE];

/** Handed to the node replacing one that was in the job loop. */
const IN_JOB_LOOP_ENV = 'NOSANA_NODE_IN_JOB_LOOP';

/** Spacing between restarts, so a node that cannot start does not hot loop. */
const RESTART_DELAY_S = 60;

const sleep = (seconds: number) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

async function installNosanaCLI(version?: string) {
  return new Promise((resolve) =>
    exec(`npm install -g @nosana/node${version ? '@' + version : ''}`, () => {
      resolve(true);
    }),
  );
}

async function nosanaCLIRunner() {
  let errorCode: number | undefined;
  const version: string | undefined = process.env.NOSANA_NODE_VERSION;
  const spinner = ora(chalk.cyan('Installing @nosana/node')).start();
  await installNosanaCLI(version);
  spinner.succeed();

  while (errorCode === undefined || RESPAWN_CODES.includes(errorCode)) {
    const inJobLoop = errorCode === UPDATE_IN_JOB_LOOP_EXIT_CODE;

    if (errorCode !== undefined && UPDATE_CODES.includes(errorCode)) {
      if (!version) {
        console.log(chalk.yellow('New @nosana/node version found.'));
        const spinner = ora(chalk.cyan('Updating @nosana/node')).start();
        await installNosanaCLI();
        spinner.succeed();
      } else {
        throw new Error(
          chalk.red(`Need newer @nosana/node version, but pinned to ${version}`),
        );
      }
    }

    if (errorCode === RESTART_EXIT_CODE) {
      console.log(
        chalk.yellow(
          `Nosana Node stopped, restarting in ${RESTART_DELAY_S} seconds.`,
        ),
      );
      await sleep(RESTART_DELAY_S);

      // Reinstall on the way back up, to pick up a version published since.
      if (!version) {
        const spinner = ora(chalk.cyan('Reinstalling @nosana/node')).start();
        await installNosanaCLI();
        spinner.succeed();
      }
    }

    console.log(chalk.green('Starting Nosana Node'));
    errorCode = await spawnPromise('nosana-node', process.argv.slice(2), {
      cwd: process.cwd(),
      detached: true,
      stdio: 'inherit',
      env: { ...process.env, [IN_JOB_LOOP_ENV]: inJobLoop ? 'true' : '' },
    });
  }

  return errorCode;
}

function spawnPromise(
  arg1: SpawnParameters[0],
  arg2: SpawnParameters[1],
  options: SpawnParameters[2],
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(arg1, arg2, options);

    // A node killed by a signal reports no code, and stopping it that way is
    // deliberate.
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

// Carry the node's code, so what supervises this wrapper can tell a deliberate
// stop from a failure.
process.exit(await nosanaCLIRunner());
