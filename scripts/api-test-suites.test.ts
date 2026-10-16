// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { apiE2eTestFiles, graphqlTestFiles, graphqlUnitTests, partitionGraphqlTests } from "./api-test-suites.ts";

test("the GraphQL partitions cover every existing test exactly once", () => {
  const all = graphqlTestFiles();
  const { unit, integration } = partitionGraphqlTests(all);
  expect([...unit, ...integration].sort()).toEqual(all);
  expect(new Set([...unit, ...integration]).size).toBe(all.length);
  expect(apiE2eTestFiles()).toContain("src/auth/api-key/__tests__/api-key.e2e.test.ts");
  expect(apiE2eTestFiles()).toContain("src/rest/__tests__");
  expect(apiE2eTestFiles()).toContain("src/mcp/__tests__");
});

test("new tests default to integration coverage; missing owned tests fail closed", () => {
  const added = "src/graphql/__tests__/new-security.test.ts";
  expect(partitionGraphqlTests([...graphqlUnitTests, added]).integration).toEqual([added]);
  expect(() => partitionGraphqlTests(graphqlUnitTests.slice(1))).toThrow("test is missing");
});

test("discovery retains nested tests and Bun's dot/underscore test filename forms", () => {
  const root = mkdtempSync(resolve(tmpdir(), "osf-suite-discovery-"));
  const directory = "src/graphql/__tests__/nested";
  try {
    mkdirSync(resolve(root, directory), { recursive: true });
    const names = ["one.test.ts", "two_test.ts", "three.spec.tsx", "four_spec.js", "five.test.mjs"];
    for (const name of [...names, "helper.ts"]) writeFileSync(resolve(root, directory, name), "");
    expect(graphqlTestFiles(root)).toEqual(names.map(name => `${directory}/${name}`).sort());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CI owns the database-free step and report/standalone commands share the integration selection", () => {
  const root = resolve(import.meta.dir, "..");
  const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
  expect(ci).toContain("bun run test:graphql-unit");
  for (const file of graphqlUnitTests) expect(ci).not.toContain(file);
  expect(readFileSync(resolve(root, "scripts/render-e2e-report.ts"), "utf8")).toContain("apiE2eTestFiles()");
  expect(JSON.parse(readFileSync(resolve(root, "apps/api/package.json"), "utf8")).scripts["test:e2e"])
    .toBe("bun ../../scripts/run-api-tests.ts e2e");
});
