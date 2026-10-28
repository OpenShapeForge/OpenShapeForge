// SPDX-License-Identifier: BUSL-1.1
/** Check that sample record-action entities only enter the explicit test composition. */
import { readFileSync } from "node:fs";

const mode = process.argv[2];
if (mode !== "production" && mode !== "test") throw new Error("Expected production or test composition.");
const paths = [
  "apps/api/src/generated/db/manifest.json",
  "apps/api/src/generated/rest/openapi.json",
  "apps/api/src/generated/graphql/documentation.json",
  "apps/api/src/generated/mcp/tools.json",
  "apps/web/src/generated/web-manifest.json",
];
const identifiers = ["ExternalProcessRun", "MeterConnection"];
for (const path of paths) {
  const artifact = readFileSync(path, "utf8");
  for (const name of identifiers) {
    const present = artifact.includes(name);
    if (present !== (mode === "test")) throw new Error(`${mode} composition: ${name} ${present ? "unexpectedly present" : "missing"} in ${path}.`);
  }
}
console.log(`${mode} composition: test entities ${mode === "test" ? "present" : "absent"} across database, REST, GraphQL, MCP and web artifacts.`);
