import chalk from 'chalk';
import { confirm, input } from '@inquirer/prompts';

import { HostManager } from '../market/hostManager.js';
import { applyLoggingProxyToClass } from '../../monitoring/proxy/loggingProxy.js';

export class RegisterHandler {
  private answers:
    | {
        email: string;
        discord: string | undefined;
        twitter: string | undefined;
      }
    | undefined;

  constructor() {
    applyLoggingProxyToClass(this);
  }

  private async gainConsent() {
    this.answers = {
      email: await input({
        message: "Your Email Address",
        validate: (value) => /\S+@\S+\.\S+/.test(value),
      }),
      discord: await input({
        message:
          "Join our Discord server for direct support from the team and community: https://nosana.com/discord. \nDiscord username:",
      }),
      twitter: await input({
        message:
          "What is your Twitter username? (If you don't use Twitter, leave blank)",
      }),
    };

    if (!this.answers.email) {
      console.log(chalk.red("Email address is required"));
      process.exit();
    }

    const accept = await confirm({
      message: `Have you read the Participation Agreement and agree to the terms and conditions contained within?\nParticipation agreement: ${chalk.blue(
        "https://drive.google.com/file/d/1dFWCT5Zon08pCPrftdxB9ByvbuDafTwy/view"
      )}`,
    });
    if (!accept) {
      console.log(
        chalk.red("To continue you must agree to the terms and conditions")
      );
      process.exit();
    }
  }

  async register() {
    await this.gainConsent();
    try {
      await HostManager.register(this.answers!.email, this.answers!.discord, this.answers!.twitter);
    } catch (error) {
      console.error('Error registering node:', error);
      process.exit();
    }
  }
}
