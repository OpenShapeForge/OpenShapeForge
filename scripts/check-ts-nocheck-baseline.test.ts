import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTsNoCheckBaseline } from "./check-ts-nocheck-baseline.mjs";

async function createFixture(files: Record<string, string>, baseline: string[]) {
  const repoRoot = await mkdtemp(join(tmpdir(), "openshapeforge-ts-nocheck-"));
  await mkdir(join(repoRoot, "src"), { recursive: true });
  for (const [path, contents] of Object.entries(files)) await writeFile(join(repoRoot, path), contents);
  await writeFile(join(repoRoot, "baseline.json"), `${JSON.stringify({ version: 1, files: baseline }, null, 2)}\n`);
  return repoRoot;
}

describe("@ts-nocheck baseline check", () => {
  test("passes when the current directives match the checked-in baseline", async () => {
    const repoRoot = await createFixture(
      { "src/kept.ts": "/** header */\n// @ts-nocheck\nexport {};\n", "src/checked.ts": "export {};\n" },
      ["src/kept.ts"],
    );
    try {
      await expect(checkTsNoCheckBaseline({ repoRoot, roots: ["src"], baselinePath: "baseline.json" }))
        .resolves.toMatchObject({ actual: ["src/kept.ts"], added: [], removed: [] });
    } finally { await rm(repoRoot, { recursive: true, force: true }); }
  });

  test("fails when a new directive is added outside the baseline", async () => {
    const repoRoot = await createFixture(
      { "src/kept.ts": "// @ts-nocheck\nexport {};\n", "src/new.ts": "// @ts-nocheck\nexport {};\n" },
      ["src/kept.ts"],
    );
    try {
      await expect(checkTsNoCheckBaseline({ repoRoot, roots: ["src"], baselinePath: "baseline.json" }))
        .rejects.toThrow(/New directives not in the baseline[\s\S]*src\/new\.ts/);
    } finally { await rm(repoRoot, { recursive: true, force: true }); }
  });

  test("fails until a removed directive is also removed from the baseline", async () => {
    const repoRoot = await createFixture({ "src/cleaned.ts": "export {};\n" }, ["src/cleaned.ts"]);
    try {
      await expect(checkTsNoCheckBaseline({ repoRoot, roots: ["src"], baselinePath: "baseline.json" }))
        .rejects.toThrow(/Baseline entries with no current directive[\s\S]*src\/cleaned\.ts/);
    } finally { await rm(repoRoot, { recursive: true, force: true }); }
  });
});
