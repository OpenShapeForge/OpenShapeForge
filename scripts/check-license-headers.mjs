// SPDX-License-Identifier: BUSL-1.1
/**
 * Fail if any first-party source file is missing its
 * `SPDX-License-Identifier: BUSL-1.1` header.
 *
 * Wired as `check:license` and mirrors the discovery rules in
 * `license-header-files.mjs`. Fix violations with
 * `bun scripts/add-license-headers.mjs`. See issue #52.
 */
import fs from "node:fs";
import path from "node:path";
import {
  SPDX_TAG,
  hasSpdxTag,
  listFirstPartySourceFiles,
  repoRoot,
} from "./license-header-files.mjs";

const missing = [];
for (const rel of listFirstPartySourceFiles()) {
  const content = fs.readFileSync(path.join(repoRoot, rel), "utf8");
  if (!hasSpdxTag(content)) missing.push(rel);
}

if (missing.length > 0) {
  console.error(
    `Missing "${SPDX_TAG}" header in ${missing.length} first-party source file(s):`,
  );
  for (const rel of missing) console.error(`  ${rel}`);
  console.error("\nRun `bun scripts/add-license-headers.mjs` to fix.");
  process.exit(1);
}

console.log(
  `All first-party source files carry the ${SPDX_TAG} header. (checked license headers)`,
);
