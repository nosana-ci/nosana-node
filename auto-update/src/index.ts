import chalk from 'chalk';
import { exec, spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import ora from 'ora';
import path from 'path';
import os from 'os';

type SpawnParameters = Parameters<typeof spawn>;

/**
 * How the node asks for another process. Keep in sync with `src/exitCodes.ts`.
 *
 * The node exits with RESPAWN_EXIT_CODE and, when it is new enough, first
 * sends an `ExitRequest` over IPC saying what it wants. The message wins when
 * there is one; without one (an older node, or a type this wrapper does not
 * know) the exit counts as an update, which is what every wrapper has always
 * done with this code. Any other code ends this wrapper too.
 */
type ExitRequest =
  | { type: 'update'; inJobLoop: boolean; requestedVersion?: string }
  | { type: 'restart'; inJobLoop: boolean };

const RESPAWN_EXIT_CODE = 129;

/** Handed to the node replacing one that was in the job loop. */
const IN_JOB_LOOP_ENV = 'NOSANA_NODE_IN_JOB_LOOP';

/** Spacing between restarts, so a node that cannot start does not hot loop. */
const RESTART_DELAY_S = 60;

/**
 * Signals that mean "stop", forwarded to the node. They cannot reach it any
 * other way: `detached` puts the node in its own session, and this wrapper is
 * PID 1 in the container, where the kernel ignores default signal
 * dispositions. Without forwarding, `docker stop` waits out its grace period,
 * SIGKILLs PID 1, and the node dies with the PID namespace — never asked to
 * shut down gracefully.
 */
const STOP_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;

/** The running node, while there is one. */
let currentChild: ChildProcess | undefined;

/** Set once a stop signal arrives, so the loop stops respawning. */
let stopSignal: NodeJS.Signals | undefined;

for (const signal of STOP_SIGNALS) {
  process.on(signal, () => {
    stopSignal = signal;
    // No node running (installing, or in the restart delay): nothing to wind
    // down, leave like a process the signal actually killed would.
    if (!currentChild) process.exit(128 + os.constants.signals[signal]);
    currentChild.kill(signal);
  });
}

const sleep = (seconds: number) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * A directory of `nosana-node-<version>.tgz` files that stand in for the
 * registry for those versions, so a build that was never published can be
 * installed. See seed.Dockerfile.
 */
const TARBALL_DIR = process.env.NOSANA_NODE_TARBALL_DIR;

/** The tarball for the version when there is one, else the registry. */
function packageSpec(version?: string) {
  if (TARBALL_DIR && version) {
    const tarball = path.join(TARBALL_DIR, `nosana-node-${version}.tgz`);
    if (existsSync(tarball)) return tarball;
  }
  return `@nosana/node${version ? '@' + version : ''}`;
}

/** @param version latest when omitted. */
async function installNosanaCLI(action: string, version?: string) {
  const spec = packageSpec(version);
  const spinner = ora(chalk.cyan(`${action} ${spec}`)).start();
  await new Promise((resolve) =>
    exec(`npm install -g ${spec}`, () => resolve(true)),
  );
  spinner.succeed();
}

async function nosanaCLIRunner() {
  const version: string | undefined = process.env.NOSANA_NODE_VERSION;
  // Only affects the first install; unlike NOSANA_NODE_VERSION it does not
  // pin, so the node still updates to latest afterwards. For exercising the
  // update cycle: seed an older version and let the node request the update.
  // A node new enough reads it too, and defers its startup version check to
  // the job loop while it is that version.
  await installNosanaCLI(
    'Installing',
    version ?? process.env.NOSANA_NODE_INITIAL_VERSION,
  );

  let inJobLoop = false;

  for (; ;) {
    console.log(chalk.green('Starting Nosana Node'));
    const exit = await spawnPromise('nosana-node', process.argv.slice(2), {
      cwd: process.cwd(),
      detached: true,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, [IN_JOB_LOOP_ENV]: inJobLoop ? 'true' : '' },
    });

    // A stop was asked of this wrapper and forwarded; however the node then
    // chose to leave — even asking for an update — it is not respawned.
    if (stopSignal) return exit.code;

    // Only a node that left with the respawn code is asking for another: a note
    // that outlived any other exit, a signal among them, is not an ask.
    const request: ExitRequest | undefined =
      exit.code === RESPAWN_EXIT_CODE
        ? exit.request ?? { type: 'update', inJobLoop: false }
        : undefined;
    if (!request) return exit.code;

    switch (request.type) {
      case 'update': {
        if (version) {
          throw new Error(
            chalk.red(
              `Need newer @nosana/node version, but pinned to ${version}`,
            ),
          );
        }
        inJobLoop = request.inJobLoop;
        const target = request.requestedVersion;
        console.log(
          chalk.yellow(
            `New @nosana/node version ${target ? target + ' ' : ''}found.`,
          ),
        );
        await installNosanaCLI('Updating to', target);
        break;
      }
      case 'restart': {
        inJobLoop = request.inJobLoop;

        // Failing before the job loop is a setup problem a restart does not
        if (!inJobLoop) {
          console.log(
            chalk.yellow('Nosana Node stopped before running a job, shutting down.'),
          );
          return exit.code;
        }

        console.log(
          chalk.yellow(
            `Nosana Node stopped, restarting in ${RESTART_DELAY_S} seconds.`,
          ),
        );
        await sleep(RESTART_DELAY_S);

        // Reinstall on the way back up, to pick up a version published since.
        if (!version) await installNosanaCLI('Installing latest');
        break;
      }
      default: {
        // Compile error when a type is added to ExitRequest but not handled
        // here; falling through would respawn with no install and no delay.
        const unhandled: never = request;
        throw new Error(`Unhandled exit request ${JSON.stringify(unhandled)}`);
      }
    }
  }
}

function isExitRequest(message: unknown): message is ExitRequest {
  const type = (message as { type?: unknown })?.type;
  return type === 'update' || type === 'restart';
}

function spawnPromise(
  arg1: SpawnParameters[0],
  arg2: SpawnParameters[1],
  options: SpawnParameters[2],
): Promise<{ code: number; request?: ExitRequest }> {
  return new Promise((resolve) => {
    const child = spawn(arg1, arg2, options);
    currentChild = child;
    let request: ExitRequest | undefined;

    child.on('message', (message) => {
      if (isExitRequest(message)) request = message;
    });

    // A node killed by a signal reports no code, and stopping it that way is
    // deliberate.
    child.on('exit', (code) => {
      currentChild = undefined;
      resolve({ code: code ?? 0, request });
    });
  });
}

// Carry the node's code, so what supervises this wrapper can tell a deliberate
// stop from a failure.
process.exit(await nosanaCLIRunner());
