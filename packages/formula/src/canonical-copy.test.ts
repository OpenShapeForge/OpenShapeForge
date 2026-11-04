// SPDX-License-Identifier: BUSL-1.1
// src/canonical is a verbatim copy of the compiler's canonical expression
// types and evaluator — the same copies the compiler emits into consumer
// repos — so a formula evaluates here exactly as it does anywhere else. In
// this monorepo the copy must match byte for byte; `bun run sync:canonical`
// refreshes it. A published tarball has no compiler beside it and skips this.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const compilerCanonical = join(import.meta.dir, "../../compiler/src/authoring/canonical");

describe.skipIf(!existsSync(compilerCanonical))("the canonical copy", () => {
  test.each(["canonical-condition.ts", "expression-evaluator.ts"])("%s matches the compiler's", (file) => {
    expect(readFileSync(join(import.meta.dir, "canonical", file), "utf8")).toBe(
      readFileSync(join(compilerCanonical, file), "utf8"),
    );
  });
});
