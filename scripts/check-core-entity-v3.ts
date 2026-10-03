#!/usr/bin/env bun
// SPDX-License-Identifier: BUSL-1.1
import { resolve } from "node:path";
import { checkCoreEntityV3, readYamlCorpus } from "./core-entity-v3";

const report = checkCoreEntityV3(readYamlCorpus(resolve(import.meta.dir, "..")));
console.log(`coreEntity v3 gate: ${report.total} YAMLs; ${report.old} old; ${report.failures.length} violations`);
if (report.failures.length) {
  console.error(report.failures.join("\n"));
  process.exitCode = 1;
}
