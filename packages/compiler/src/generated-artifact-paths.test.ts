// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  compilerOwnedGeneratedRoots,
  orphanCompilerGeneratedFiles,
  retiredCompilerGeneratedRoots,
} from "./generated-artifact-paths.js";

const repoRoot = resolve(import.meta.dir, "../../..");

describe("retired generated roots", () => {
  test("remain ignored and owned after their plugin is removed", async () => {
    const ignoreLines = new Set(
      (await readFile(resolve(repoRoot, ".gitignore"), "utf8"))
        .split(/\r?\n/u)
        .map((line) => line.trim()),
    );

    for (const root of retiredCompilerGeneratedRoots) {
      expect(compilerOwnedGeneratedRoots).toContain(root);
      expect(ignoreLines).toContain(`${root}/`);
    }
  });

  test("treats unexpected files in every retired root as orphans", () => {
    const unexpected = retiredCompilerGeneratedRoots.map((root) => `${root}/unexpected.json`);
    expect(orphanCompilerGeneratedFiles(unexpected, new Set())).toEqual(unexpected);
    expect(orphanCompilerGeneratedFiles(unexpected, new Set([unexpected[0]!]))).toEqual(
      unexpected.slice(1),
    );
  });
});
