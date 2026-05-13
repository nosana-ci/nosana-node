import chalk from "chalk";
import { confirm, input } from "@inquirer/prompts";
import { Client, Flow, OpState } from "@nosana/sdk";

import { specsAndNetworkJob } from "../../../static/index.js";
import { Provider } from "../../provider/Provider.js";
import { NodeRepository } from "../../repository/NodeRepository.js";
import { applyLoggingProxyToClass } from "../../monitoring/proxy/loggingProxy.js";
import { generateRandomId } from "../utils/generateRandomId.js";
import TaskManager from "../task/TaskManager.js";
import { clientSelector } from "../../client/index.js";

export class RegisterHandler {
  private nodeId: string;
  private answers:
    | {
        email: string;
        discord: string | undefined;
        twitter: string | undefined;
      }
    | undefined;

  constructor(
    private sdk: Client,
    private provider: Provider,
    private repository: NodeRepository
  ) {
    this.nodeId = this.sdk.solana.provider!.wallet.publicKey.toString();

    applyLoggingProxyToClass(this);
  }

  private async gainConstent() {
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

  private async runSpecs(): Promise<Flow> {
    const flowId = generateRandomId(32);
    const task = new TaskManager(
      this.provider,
      this.repository,
      flowId,
      this.sdk.solana.wallet.publicKey.toString(),
      specsAndNetworkJob
    );
    task.bootstrap();
    await task.start();

    const result = this.repository.getFlow(flowId);

    if (!result || result.state.status !== "success") {
      throw new Error("Registration Benchmark Failed");
    }

    return result;
  }

  private async submitOnboarding(results: OpState[]) {
    try {
      const { response } = await clientSelector({ withAuth: true }).POST(
        // @ts-expect-error: route not yet in OpenAPI schema
        "/api/nodes/join-test-grid",
        {
          body: {
            ...this.answers!,
            nodeAddress: this.nodeId,
            results,
          },
        }
      );

      if (!response.ok) {
        console.error("Error whilst submiting onboarding request.");
        process.exit();
      }
    } catch (error) {
      console.error("Error whilst submiting onboarding request.", error);
      process.exit();
    }
  }

  async register() {
    await this.gainConstent();
    const results = await this.runSpecs();
    await this.submitOnboarding(results.state.opStates);
  }
}
