import typia from "typia";
import { Response } from "express";
import { JobDefinition } from "@nosana/sdk";

import { getSDK } from "../../../../sdk/index.js";
import { NodeAPIRequest } from "../../types/index.js";
import { generateRandomId } from "../../../utils/generateRandomId.js";
import TaskManager from "../../../task/TaskManager.js";
import { clientSelector } from "../../../../client/index.js";

export async function postNodeValidation(
  req: NodeAPIRequest<{}, JobDefinition>,
  res: Response
) {
  const sdk = getSDK();
  const provider = req.provider!;
  const repository = req.repository!;
  const validator = typia.createValidateEquals<JobDefinition>();

  if (!req.body) {
    return res.status(400).send("Missing job definition.");
  }

  const isValid = validator(req.body);

  if (!isValid.success) {
    res.status(400).send(
      JSON.stringify({
        error: "Failed to validate job defintion.",
        message: isValid.errors,
      })
    );
  }

  const sessionId = res.locals["session_id"]!;

  if (sessionId !== "ADMIN") {
    res.status(200).send();
  }

  const id = generateRandomId(32);

  try {
    const task = new TaskManager(provider, repository, id, sessionId, req.body);
    task.bootstrap();
    await task.start();

    const result = repository.getFlow(id);

    if (sessionId === "ADMIN") {
      res.status(200).send(result.state.opStates[0].results!["prediction"][0]);
      return;
    }

    await clientSelector().POST(
      // @ts-expect-error: route not yet in OpenAPI schema
      "/api/benchmarks/submit",
      {
        body: result.state,
        headers: {
          Authorization: await sdk.authorization.generate(sessionId, {
            includeTime: true,
          }),
        },
      }
    );
  } catch (error) {
    throw error;
  }
}
