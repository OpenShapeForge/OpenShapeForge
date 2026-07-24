// SPDX-License-Identifier: BUSL-1.1
/**
 * Insert an `SPDX-License-Identifier: BUSL-1.1` header into every first-party
 * source file that lacks one.
 *
 * Deterministic and idempotent: rerunning is a no-op once headers are present.
 * The header is placed after any leading shebang / `@ts-nocheck` directive so
 * those keep working. Run with `bun scripts/add-license-headers.mjs`; verify
 * with `bun run check:license`.
 */
import fs from "node:fs";
import path from "node:path";
import {
  listFirstPartySourceFiles,
  repoRoot,
  withSpdxHeader,
} from "./license-header-files.mjs";

let changed = 0;
for (const rel of listFirstPartySourceFiles()) {
  const abs = path.join(repoRoot, rel);
  const original = fs.readFileSync(abs, "utf8");
  const updated = withSpdxHeader(original);
  if (updated !== original) {
    fs.writeFileSync(abs, updated);
    changed += 1;
    console.log(`+ ${rel}`);
  }
}

console.log(
  changed === 0
    ? "All first-party source files already carry the SPDX header."
    : `Added SPDX header to ${changed} file(s).`,
);
