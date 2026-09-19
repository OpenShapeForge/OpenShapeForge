// SPDX-License-Identifier: BUSL-1.1
/**
 * A plugin entity that declares `versioning: publishedSnapshot` publishes
 * through the generic runtime, in its own schema.
 *
 * `Notebook` and `NotebookVersion` come from the notebook example plugin's
 * authoring layer (`examples/plugins/notebook/`), module `notebook`, so their
 * tables are `notebook.notebooks` and `notebook.notebook_versions` rather
 * than anything under `erp`. The publish handler executes against the
 * storage the compiler bound into the manifest; a runtime that assumed the
 * core schema would answer with a missing relation here. Driven over the
 * assembled API, as a client would: create the head, publish twice, read the
 * versions back through the generated read surface.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/graphql/__tests__/plugin-versioning.e2e.test.ts 2>&1
 */
import { expect } from "bun:test";
import { describe, expectData, gql, registerSuiteLifecycle, tenantA, test } from "./e2e/harness.js";
import { createRow, eligibleTablesByEntityName } from "./e2e/entity-factory.js";
import { collectionOf, fetchRecord, listDoc } from "./e2e/gql-shapes.js";

registerSuiteLifecycle();

const notebook = eligibleTablesByEntityName.get("Notebook")!;
const notebookVersion = eligibleTablesByEntityName.get("NotebookVersion")!;

const PUBLISH = "mutation Publish($input: JSON!) { notebookPublish(input: $input) }";
const VERSIONS = listDoc(notebookVersion, { variables: ["filter"], selection: "id versionNumber status contentHash snapshot publishedBy" });

describe("plugin entity versioning (notebook schema)", () => {
  test("the notebook tables live outside the core schema", () => {
    expect(notebook.name).toBe("notebook.notebooks");
    expect(notebookVersion.name).toBe("notebook.notebook_versions");
    expect(notebook.source?.versioning?.storage).toEqual({
      head: { schema: "notebook", table: "notebooks" },
      version: { schema: "notebook", table: "notebook_versions", headColumn: "notebook_id" },
      owned: [],
    });
  });

  test("Notebook.publish stores a NotebookVersion in the plugin schema and the head points at it", async () => {
    const id = await createRow(notebook, tenantA, { name: "Field notes", body: "First draft" });
    const draft = await fetchRecord(tenantA, notebook, id, "id updatedAt lifecycleStatus publishedVersion");
    expect(draft.lifecycleStatus).toBe("draft");
    expect(draft.publishedVersion).toBeNull();

    // The publish handler answers with the stored version row.
    const published = (await expectData(tenantA, PUBLISH, { input: { id, expectedVersion: draft.updatedAt } })).notebookPublish;
    expect(published).toMatchObject({ notebook_id: id, version_number: 1, status: "published", published_by: tenantA.userId });
    expect(published.content_hash).toMatch(/^[a-f0-9]{64}$/);

    const head = await fetchRecord(tenantA, notebook, id, "id updatedAt lifecycleStatus latestVersion publishedVersion publishedVersionId");
    expect(head).toMatchObject({ lifecycleStatus: "published", latestVersion: 1, publishedVersion: 1, publishedVersionId: published.id });

    // An unchanged head republished is the same content: the same version comes back, no new row.
    const second = (await expectData(tenantA, PUBLISH, { input: { id, expectedVersion: head.updatedAt } })).notebookPublish;
    expect(second.id).toBe(published.id);
    expect(second.version_number).toBe(1);
    expect(second.content_hash).toBe(published.content_hash);

    const listed = await gql(tenantA, VERSIONS, { filter: { notebook: id } });
    const versions = [...collectionOf(notebookVersion, listed, notebookVersion.source!.graphql!.listQueryName).items]
      .sort((left, right) => left.versionNumber - right.versionNumber);
    expect(versions.map((row: { versionNumber: number }) => row.versionNumber)).toEqual([1]);
    const snapshot = versions[0].snapshot;
    expect(snapshot).toMatchObject({ schemaVersion: 1, entity: "Notebook", head: { table: "notebooks", children: {} } });
    expect(snapshot.head.row).toMatchObject({ id, name: "Field notes", body: "First draft" });
    // Content only: no publication pointers, no bookkeeping, no earlier versions.
    for (const column of ["latest_version", "published_version_id", "lifecycle_status", "created_at", "updated_at"]) {
      expect(snapshot.head.row).not.toHaveProperty(column);
    }
    expect(JSON.stringify(snapshot)).not.toContain("notebook_versions");
  });
});
