#!/usr/bin/env bun
// SPDX-License-Identifier: BUSL-1.1
//
// Prints the test files of one CI shard of `bun test packages/compiler`, one
// path per line, for `bun test $(bun scripts/compiler-test-shard.mjs <shard>)`.
//
// Bun 1.3 has no --shard, and the suite is dominated by a few files (index and
// plugins alone are over half of its ~6 minutes), so the split is by file:
// the named shards run their listed files, and `rest` runs every other test
// file under packages/compiler. A new test file therefore lands in `rest`
// without anyone editing this list, and the union of the shards is always
// exactly what `bun test packages/compiler` would have run.
//
// Each shard runs in a process of its own, as the whole suite did. The test
// files that write to disk do so under temporary directories, and every file
// passes when run on its own, so no shard depends on another having run.

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = "packages/compiler";
const REST = "rest";

// Balanced on the per-file times of a CI run (index ~115s; plugins ~85s,
// tenant-identity-relations ~37s and layers ~23s; everything else ~120s).
const SHARDS = {
  index: ["packages/compiler/src/index.test.ts"],
  plugins: [
    "packages/compiler/src/plugins.test.ts",
    "packages/compiler/src/authoring/tenant-identity-relations.test.ts",
    "packages/compiler/src/authoring/layers.test.ts",
  ],
};

// The file names bun test discovers.
const TEST_FILE = /[._](test|spec)\.[cm]?[jt]sx?$/;

function discover(dir) {
  const files = [];
  for (const entry of readdirSync(join(REPO_ROOT, dir), {
    withFileTypes: true,
  })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...discover(path));
    else if (TEST_FILE.test(entry.name)) files.push(path);
  }
  return files;
}

const shard = process.argv[2];
const named = Object.values(SHARDS).flat();

for (const file of named) {
  if (!existsSync(join(REPO_ROOT, file)) || !TEST_FILE.test(file)) {
    console.error(
      `compiler-test-shard.mjs: ${file} is not a test file; update SHARDS`,
    );
    process.exit(1);
  }
}

let files;
if (shard === REST) {
  files = discover(ROOT).filter((file) => !named.includes(file));
} else if (Object.hasOwn(SHARDS, shard ?? "")) {
  files = SHARDS[shard];
} else {
  console.error(
    `usage: compiler-test-shard.mjs <${[...Object.keys(SHARDS), REST].join("|")}>`,
  );
  process.exit(1);
}

// `./` makes each argument a path rather than a substring filter for bun test.
console.log(
  files
    .sort()
    .map((file) => `./${file}`)
    .join("\n"),
);
