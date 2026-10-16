// SPDX-License-Identifier: BUSL-1.1
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const apiRoot = resolve(import.meta.dir, "../apps/api");
// Owned by CI's database-free GraphQL step. List exact files rather than
// guessing from a .unit suffix: some of these exercise the real HTTP adapter.
export const graphqlUnitTests = [
  "introspection", "observability-readiness", "root-ordering", "transport-hardening",
  "classified-query-guard.unit", "classified-nullability.unit", "description-projection.unit",
  "immutable-writability.unit", "query-hardening.unit", "list-input-allowlist.unit",
  "decimal-scalar.unit",
].map(name => `src/graphql/__tests__/${name}.test.ts`);

export function graphqlTestFiles(root = apiRoot, relative = "src/graphql/__tests__"): string[] {
  return readdirSync(join(root, relative), { withFileTypes: true }).flatMap(entry => {
    const path = `${relative}/${entry.name}`;
    return entry.isDirectory() ? graphqlTestFiles(root, path) : /[._](?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  }).sort();
}

export function partitionGraphqlTests(files: string[]) {
  const unit = new Set(graphqlUnitTests);
  for (const file of unit) {
    if (!files.includes(file)) throw new Error(`Database-free GraphQL test is missing: ${file}`);
  }
  return { unit: [...unit], integration: files.filter(file => !unit.has(file)) };
}

export function apiE2eTestFiles() {
  return [
    ...partitionGraphqlTests(graphqlTestFiles()).integration,
    "src/rest/__tests__",
    "src/mcp/__tests__",
    "src/auth/api-key/__tests__/api-key.e2e.test.ts",
  ];
}
