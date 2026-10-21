#!/usr/bin/env bun
// SPDX-License-Identifier: BUSL-1.1
import { apiE2eTestFiles, apiRoot, graphqlTestFiles, partitionGraphqlTests } from "./api-test-suites.ts";

const suite = process.argv[2];
const files = suite === "graphql-unit"
  ? partitionGraphqlTests(graphqlTestFiles()).unit
  : suite === "e2e" ? apiE2eTestFiles() : undefined;
if (!files) throw new Error("Expected graphql-unit or e2e");
const child = Bun.spawn([process.execPath, "test", ...files, ...process.argv.slice(3)], {
  cwd: apiRoot, env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
process.exit(await child.exited);
