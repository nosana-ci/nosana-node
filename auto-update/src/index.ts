import chalk from 'chalk';
import { exec, spawn } from 'child_process';
import ora from 'ora';

type SpawnParameters = Parameters<typeof spawn>;

const SPINNER_INTERVAL = process.env.SPINNER_INTERVAL ? parseInt(process.env.SPINNER_INTERVAL, 10) : 5000;

async function installNosanaCLI(version?: string) {
  return new Promise((resolve) =>
    exec(`npm install -g @nosana/node${version ? '@' + version : ''}`, () => {
      resolve(true);
    }),
  );
}

async function nosanaCLIRunner() {
  let errorCode;
  const version: string | undefined = process.env.NOSANA_NODE_VERSION;
  const spinner = ora({ text: chalk.cyan('Installing @nosana/node'), interval: SPINNER_INTERVAL }).start();
  await installNosanaCLI(version);
  spinner.succeed();

  while (errorCode === undefined || errorCode === 129) {
    if (errorCode === 129) {
      if (!version) {
        console.log(chalk.yellow('New @nosana/node version found.'));
        const spinner = ora({ text: chalk.cyan('Updating @nosana/node'), interval: SPINNER_INTERVAL }).start();
        await installNosanaCLI();
        spinner.succeed();
      } else {
        throw new Error(
          chalk.red(`Need newer @nosana/node version, but pinned to ${version}`),
        );
      }
    }
    console.log(chalk.green('Starting Nosana Node'));
    const code = await spawnPromise('nosana-node', process.argv.slice(2), {
      cwd: process.cwd(),
      detached: true,
      stdio: 'inherit',
    });

    errorCode = code;
  }
}

function spawnPromise(
  arg1: SpawnParameters[0],
  arg2: SpawnParameters[1],
  options: SpawnParameters[2],
) {
  return new Promise((resolve) => {
    const child = spawn(arg1, arg2, options);

    child.on('exit', (code) => resolve(code));
  });
}

await nosanaCLIRunner();
