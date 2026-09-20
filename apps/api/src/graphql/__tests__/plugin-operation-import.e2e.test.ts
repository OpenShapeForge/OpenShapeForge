// SPDX-License-Identifier: BUSL-1.1
/**
 * The notebook example plugin's own Operation, `notebook.import`, driven over
 * the assembled API against the real tables: the one module-level plugin
 * Operation this repository composes, and so the proof that a plugin
 * handler's write lands where the contract says, once per idempotency key,
 * inside the caller's tenant, and loses cleanly to a publish.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/graphql/__tests__/plugin-operation-import.e2e.test.ts 2>&1
 */
import { randomUUID } from "node:crypto";
import { expect } from "bun:test";
import { describe, expectData, gql, registerSuiteLifecycle, tenantA, tenantB, test } from "./e2e/harness.js";
import { createRow, eligibleTablesByEntityName } from "./e2e/entity-factory.js";
import { collectionOf, fetchRecord, listDoc } from "./e2e/gql-shapes.js";

registerSuiteLifecycle();

const notebook = eligibleTablesByEntityName.get("Notebook")!;
const notebookVersion = eligibleTablesByEntityName.get("NotebookVersion")!;

const IMPORT = "mutation Import($input: JSON!) { notebookImport(input: $input) }";
const PUBLISH = "mutation Publish($input: JSON!) { notebookPublish(input: $input) }";
const VERSIONS = listDoc(notebookVersion, { variables: ["filter"], selection: "id versionNumber snapshot" });
const HEAD = "id updatedAt body lifecycleStatus publishedVersion";

const errorCode = (result: { errors?: Array<{ extensions?: Record<string, unknown> }> }) =>
  result.errors?.[0]?.extensions?.code;

describe("notebook.import (plugin Operation over the API)", () => {
  test("replaces a draft's body and advances its version token", async () => {
    const id = await createRow(notebook, tenantA, { name: "Imports", body: "before" });
    const before = await fetchRecord(tenantA, notebook, id, HEAD);

    const imported = (await expectData(tenantA, IMPORT, {
      input: { notebookId: id, body: "after", idempotencyKey: randomUUID() },
    })).notebookImport;
    expect(imported).toMatchObject({ status: "accepted", notebookId: id });
    expect(imported.importId).toMatch(/^[0-9a-f-]{36}$/);

    const after = await fetchRecord(tenantA, notebook, id, HEAD);
    expect(after).toMatchObject({ body: "after", lifecycleStatus: "draft" });
    // The optimistic-write token moved, so a stale expectedVersion is refused.
    expect(new Date(after.updatedAt).getTime()).toBeGreaterThan(new Date(before.updatedAt).getTime());
  });

  test("the body is not optional", async () => {
    const id = await createRow(notebook, tenantA, { name: "No body", body: "kept" });
    const refused = await gql(tenantA, IMPORT, { input: { notebookId: id, idempotencyKey: randomUUID() } });
    expect(refused.errors?.length).toBeGreaterThan(0);
    expect((await fetchRecord(tenantA, notebook, id, HEAD)).body).toBe("kept");
  });

  test("the same idempotency key replays the first outcome without a second write", async () => {
    const id = await createRow(notebook, tenantA, { name: "Replay", body: "v0" });
    const input = { notebookId: id, body: "v1", idempotencyKey: randomUUID() };
    const first = (await expectData(tenantA, IMPORT, { input })).notebookImport;
    const written = await fetchRecord(tenantA, notebook, id, HEAD);

    const again = (await expectData(tenantA, IMPORT, { input })).notebookImport;
    expect(again).toEqual(first);
    const unchanged = await fetchRecord(tenantA, notebook, id, HEAD);
    expect(unchanged.body).toBe("v1");
    expect(unchanged.updatedAt).toBe(written.updatedAt);
  });

  test("another tenant's notebook is not found, not forbidden, and stays untouched", async () => {
    const id = await createRow(notebook, tenantA, { name: "Fenced", body: "mine" });
    const foreign = await gql(tenantB, IMPORT, { input: { notebookId: id, body: "theirs", idempotencyKey: randomUUID() } });
    expect(errorCode(foreign)).toBe("NOT_FOUND");
    expect((await fetchRecord(tenantA, notebook, id, HEAD)).body).toBe("mine");
  });

  test("a published notebook refuses an import with CONFLICT", async () => {
    const id = await createRow(notebook, tenantA, { name: "Published", body: "final" });
    const draft = await fetchRecord(tenantA, notebook, id, HEAD);
    await expectData(tenantA, PUBLISH, { input: { id, expectedVersion: draft.updatedAt } });

    const refused = await gql(tenantA, IMPORT, { input: { notebookId: id, body: "late", idempotencyKey: randomUUID() } });
    expect(errorCode(refused)).toBe("CONFLICT");
    expect((await fetchRecord(tenantA, notebook, id, HEAD))).toMatchObject({ body: "final", lifecycleStatus: "published" });
  });

  test("an import racing a publish either lands in the published snapshot or loses with CONFLICT", async () => {
    const id = await createRow(notebook, tenantA, { name: "Race", body: "draft" });
    const draft = await fetchRecord(tenantA, notebook, id, HEAD);

    const [publish, imported] = await Promise.all([
      gql(tenantA, PUBLISH, { input: { id, expectedVersion: draft.updatedAt } }),
      gql(tenantA, IMPORT, { input: { notebookId: id, body: "imported", idempotencyKey: randomUUID() } }),
    ]);

    const head = await fetchRecord(tenantA, notebook, id, HEAD);
    const listed = await gql(tenantA, VERSIONS, { filter: { notebook: id } });
    const versions = [...collectionOf(notebookVersion, listed, notebookVersion.source!.graphql!.listQueryName).items];

    if (imported.errors?.length) {
      // The publish committed first: the import found no draft to change.
      expect(errorCode(imported)).toBe("CONFLICT");
      expect(publish.errors ?? []).toEqual([]);
      expect(head).toMatchObject({ body: "draft", lifecycleStatus: "published" });
      expect(versions.map((row: { snapshot: any }) => row.snapshot.head.row.body)).toEqual(["draft"]);
    } else {
      // The import committed first: whatever got published carries its body,
      // or the publish lost its version token to the import and refused.
      expect(head.body).toBe("imported");
      if (publish.errors?.length) {
        expect(head.lifecycleStatus).toBe("draft");
        expect(versions).toEqual([]);
      } else {
        expect(head.lifecycleStatus).toBe("published");
        expect(versions.map((row: { snapshot: any }) => row.snapshot.head.row.body)).toEqual(["imported"]);
      }
    }
  });
});
