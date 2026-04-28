/**
 * Post-generation patch for the host-manager OpenAPI schema.
 *
 * openapi-typescript@7 incorrectly generates `Record<string, never>` for
 * JSON Schema `patternProperties`.
 *
 * This script patches only the `postBenchmarksByIdSubmit-results` operation
 * block so that `FlowState` from @nosana/sdk is directly assignable to the
 * request body without casts.
 */

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(
  __dirname,
  "../src/NodeManager/clients/hostManager/schema.d.ts",
);

const content = readFileSync(schemaPath, "utf8");

const START_MARKER = '"postBenchmarksByIdSubmit-results":';
const END_MARKER = "postBenchmarksByIdSeed:";

const startIdx = content.indexOf(START_MARKER);
if (startIdx === -1) {
  console.error("patch-host-manager-schema: could not find start marker");
  process.exit(1);
}

const endIdx = content.indexOf(END_MARKER, startIdx);
if (endIdx === -1) {
  console.error("patch-host-manager-schema: could not find end marker");
  process.exit(1);
}

let section = content.slice(startIdx, endIdx);

// patternProperties: { "^(.*)$": { anyOf: [string, string[]] } }
// incorrectly generated as Record<string, never>
section = section.replaceAll(
  "results?: Record<string, never>;",
  "results?: Record<string, string | string[]>;",
);

// patternProperties: { "^(.*)$": { type: "string" } }
// incorrectly generated as Record<string, never>
section = section.replaceAll(
  "env?: Record<string, never>;",
  "env?: Record<string, string>;",
);

// patternProperties: { "^(.*)$": {} }
// incorrectly generated as Record<string, never>
section = section.replaceAll(
  "secrets?: Record<string, never>;",
  "secrets?: Record<string, unknown>;",
);

const patched = content.slice(0, startIdx) + section + content.slice(endIdx);
writeFileSync(schemaPath, patched, "utf8");
console.log("patch-host-manager-schema: applied patches to schema.d.ts");
