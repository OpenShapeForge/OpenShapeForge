// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { print, parse } from "graphql";
import { generatePersistedOperationArtifacts } from "./persisted-operations.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("persisted operation artifacts", () => {
  test("collects checked-in, generated, conditional, and config operations deterministically", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "osf-persisted-"));
    roots.push(repoRoot);
    const sourceDir = join(repoRoot, "apps/web/src/features");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "operations.ts"),
      `
        const HEALTH = "query HealthProbe { health { role status } }";
        const query = enabled
          ? HEALTH
          : "mutation RenameThing($id: ID!) { renameThing(id: $id) }";
      `,
    );
    const pluginWebDir = join(repoRoot, "examples/plugins/workflow/web");
    await mkdir(pluginWebDir, { recursive: true });
    await writeFile(
      join(pluginWebDir, "page.tsx"),
      "const query = `query PluginWebThing { health { status } }`;",
    );
    const generatedWebSources = new Map([
      [
        "generated/action.ts",
        "const query = `query GeneratedThing { health { status } }`;",
      ],
    ]);
    const input = {
      repoRoot,
      generatedWebSources,
      pageConfigs: [{ query: "query ConfigThing { health { status } }" }],
    };

    const first = await generatePersistedOperationArtifacts(input);
    const second = await generatePersistedOperationArtifacts(input);
    expect(first).toEqual(second);
    expect(first[0]!.contents).toBe(first[1]!.contents);

    const manifest = JSON.parse(first[0]!.contents) as {
      checksum: string;
      operationNames: string[];
      operations: Record<string, string>;
    };
    expect(manifest.operationNames).toEqual([
      "ConfigThing",
      "GeneratedThing",
      "HealthProbe",
      "PluginWebThing",
      "RenameThing",
    ]);
    const canonical = print(
      parse("query HealthProbe { health { role status } }"),
    );
    const hash = createHash("sha256").update(canonical).digest("hex");
    expect(manifest.operations[hash]).toBe(canonical);
    expect(JSON.stringify(manifest.operations)).not.toContain("enabled");
    expect(manifest.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  test("fails generation when a first-party call cannot enter the manifest", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "osf-persisted-"));
    roots.push(repoRoot);
    const sourceDir = join(repoRoot, "apps/web/src");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "dynamic.ts"),
      `executeGraphqlRequest({ query: buildQuery(runtimeValue) });`,
    );
    await expect(
      generatePersistedOperationArtifacts({
        repoRoot,
        generatedWebSources: new Map(),
        pageConfigs: [],
      }),
    ).rejects.toThrow(/profile: "integration"/);

    await writeFile(
      join(sourceDir, "dynamic.ts"),
      `executeGraphqlRequest({ query: buildQuery(runtimeValue), profile: "integration" });`,
    );
    await expect(
      generatePersistedOperationArtifacts({
        repoRoot,
        generatedWebSources: new Map(),
        pageConfigs: [],
      }),
    ).resolves.toHaveLength(2);
  });

  test("resolves shadowed bindings in their lexical scope", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "osf-persisted-"));
    roots.push(repoRoot);
    const sourceDir = join(repoRoot, "apps/web/src");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "scoped.ts"),
      `
      function one() {
        const query = "query ScopedOne { health { status } }";
        return executeGraphqlRequest({ query });
      }
      function two() {
        const query = "query ScopedTwo { health { role } }";
        return executeGraphqlRequest({ query });
      }
    `,
    );
    const [artifact] = await generatePersistedOperationArtifacts({
      repoRoot,
      generatedWebSources: new Map(),
      pageConfigs: [],
    });
    expect(JSON.parse(artifact!.contents).operationNames).toEqual([
      "ScopedOne",
      "ScopedTwo",
    ]);
  });
});
