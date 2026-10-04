// SPDX-License-Identifier: BUSL-1.1
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assertEntityValuesValid, assertOperationInputValid } from "../src/operations/entity/input-validation.js";
import { createInput, createRow, eligibleTablesByName, fieldName, graphqlTables, tables, textColumnFor } from "../src/graphql/__tests__/e2e/entity-factory.js";
import { E2E_READWRITE_ROLES, createdRows, getRuntime, getSeedRuntime, gql, type Identity } from "../src/graphql/__tests__/e2e/harness.js";
import { createDoc, deleteRecord, deletedOf, expectOperationData, expectOperationError, fetchRecord, listDoc, updateRecord } from "../src/graphql/__tests__/e2e/gql-shapes.js";
import { isEntityBackedCreate, operationContractFor } from "../src/graphql/__tests__/e2e/operations.js";
import { expectedDeleteOutcome } from "../src/graphql/__tests__/e2e/reference-policy.js";
import { isGeneratedCrudOperationEnabled } from "../src/operations/entity/index.js";
import { documentLifecycleException } from "./result-policy.js";

const identity: Identity = {
  tenantId: process.env.PERF_TENANT_ID!,
  userId: process.env.PERF_USER_ID!,
  roles: [...E2E_READWRITE_ROLES],
};
const catalogPath = process.env.PERF_CATALOG_PATH!;

// Retain only these owned dependency fixtures until the bounded benchmark ends.
// The caller's isolated database lifecycle removes them; do not run the e2e
// afterAll row drain before k6 consumes their references.
afterAll(async () => {
  await getRuntime().close();
  await getSeedRuntime().close();
});

test("prepare every exposed canonical lifecycle and prove all five operations", async () => {
  expect(identity.tenantId).toMatch(/^[0-9a-f-]{36}$/);
  expect(identity.userId).toMatch(/^[0-9a-f-]{36}$/);
  expect(catalogPath).toBeTruthy();
  // The first canonical theme becomes the tenant default and is protected
  // against deletion. Retain that dependency, so the measured theme is a
  // normal non-default theme; never bypass its product invariant.
  const defaultTheme = graphqlTables.find(table => table.source!.authoringEntityName === "DocumentTheme");
  if (defaultTheme) await createRow(defaultTheme, identity);
  const entities = [];
  const referencePolicyEvidence = [];
  for (const table of graphqlTables) {
    const graphql = table.source!.graphql!;
    const slug = (table.source as { authoringEntitySlug?: string }).authoringEntitySlug;
    if (!slug) throw new Error(`${table.name}: missing manifest entity slug`);
    const create = operationContractFor(table, "create")!;
    const update = operationContractFor(table, "update")!;
    const deletion = operationContractFor(table, "delete")!;
    const column = textColumnFor(table);
    if (!column) throw new Error(`${table.name}: no caller-writable update fixture`);
    const updateField = fieldName(column);
    const input = await createInput(table, identity, { [updateField]: `perf-${slug}-base` });
    if (isEntityBackedCreate(table)) assertEntityValuesValid(create, table, input, { partial: false });
    else assertOperationInputValid(create, input);
    const created = expectOperationData(table, await gql(identity, createDoc(table, "id updatedAt"), { input }), graphql.createMutationName);
    expect(typeof created?.id).toBe("string");
    const current = await fetchRecord(identity, table, created.id, "id updatedAt");
    expect(current?.id).toBe(created.id);
    const listed = expectOperationData(table, await gql(identity, listDoc(table, { args: "first: 25", selection: "id" })), graphql.listQueryName);
    expect(listed.items.length).toBeGreaterThan(0);
    const updated = expectOperationData(table, await updateRecord(identity, table, created.id, { [updateField]: `perf-${slug}-updated` }, { selection: "id updatedAt" }), graphql.updateMutationName);
    expect(updated.id).toBe(created.id);
    if (table.source!.authoringEntityName === "Document") {
      const outcome = await expectedDeleteOutcome(table, created.id, identity);
      const version = eligibleTablesByName.get("erp.document_versions")!;
      const versionPolicy = { update: isGeneratedCrudOperationEnabled(version, "update"), delete: isGeneratedCrudOperationEnabled(version, "delete") };
      expect(documentLifecycleException("Document", outcome.referencing, versionPolicy)).toBe(true);
      const refusal = expectOperationError(table, await deleteRecord(identity, table, created.id), graphql.deleteMutationName, "REFERENCE_IN_USE");
      expect((await fetchRecord(identity, table, created.id))?.id).toBe(created.id);
      referencePolicyEvidence.push({ entity: "Document", successfulOperations: ["create", "get", "list", "update"],
        refusedOperation: "delete", refusalCode: refusal.code, owningCompanions: outcome.referencing,
        companionCallerPolicy: versionPolicy, noExistingCallerCleanup: true, measuredOperationCount: 0 });
      console.log(JSON.stringify({ ...referencePolicyEvidence.at(-1), canonicalOperationsPassed: 4, expectedDeleteRefusal: refusal.code }));
      continue;
    }
    expect(deletedOf(table, await deleteRecord(identity, table, created.id))).toBe(true);
    entities.push({
      table: table.name, entity: table.source!.authoringEntityName, slug, graphql,
      createInput: input, createInputType: isEntityBackedCreate(table) ? `Create${graphql.typeName}Input` : "JSON",
      idempotencyField: create.reliability.idempotency.inputField ?? null,
      updateField, updateValue: `perf-${slug}-updated`,
      controls: { update: { concurrency: update.concurrency ?? null, confirmation: update.interaction.confirmation }, delete: { concurrency: deletion.concurrency ?? null, confirmation: deletion.interaction.confirmation } },
    });
    console.log(JSON.stringify({ entity: table.source!.authoringEntityName, canonicalOperationsPassed: 5 }));
  }
  const exclusions = tables.filter(table => !graphqlTables.includes(table)).map(table => ({
    entity: table.source!.authoringEntityName,
    classification: "graphql-disabled",
    reason: "GraphQL projection disabled",
    operations: ["list", "get", "create", "update", "delete"].filter(op => table.source!.graphql!.operations?.[op as "list"] === false),
  }));
  expect(entities.length + exclusions.length + referencePolicyEvidence.length).toBe(tables.length);
  expect(referencePolicyEvidence.length).toBe(1);
  const catalog = { tenantId: identity.tenantId, userId: identity.userId, roles: identity.roles, entities,
    exclusions: [...exclusions, ...referencePolicyEvidence.map(evidence => ({ entity: evidence.entity,
      classification: "owning-companion-delete-policy", reason: "Canonical create owns a version which forbids caller cleanup; delete correctly refuses REFERENCE_IN_USE" }))],
    referencePolicyEvidence,
    preflightEntityCount: entities.length, preflightOperationCount: entities.length * 5,
    dependencyFixtureCount: createdRows.length, dependenciesPreparedOutsideTimedBenchmark: true };
  mkdirSync(dirname(catalogPath), { recursive: true });
  writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n", { mode: 0o600 });
}, 120_000);
