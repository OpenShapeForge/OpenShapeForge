// SPDX-License-Identifier: BUSL-1.1
/**
 * A published snapshot describes content, never publication history.
 * `template_versions.template_id` is an owned (cascading) reference to the
 * head, so the generic child walk would embed versions 1..N-1 inside version
 * N: quadratic storage, and a content hash that changed with every publish of
 * identical content. The version table is excluded by its compiler-bound
 * storage, which this proves against the real generated schema.
 *
 * Run (cwd apps/api):
 *   SCRATCH_ADMIN_DATABASE_URL=postgres://openshapeforge:openshapeforge@127.0.0.1:5435/postgres \
 *     bun test src/modules/versioning-snapshot-history-db.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { parseSnapshot, type SnapshotNode } from "@openshapeforge/versioning/snapshot";
import { closeScratch, editor, openScratch, platformFor, privileged, publishTemplate, seedTemplate } from "../documents/__tests__/document-content-fixture.js";

type VersionRow = { id: string; version_number: number; content_hash: string; snapshot: unknown };

async function versions(templateId: string): Promise<VersionRow[]> {
  return (await sql<VersionRow>`select id, version_number, content_hash, snapshot from erp.template_versions
    where template_id = ${templateId}::uuid order by version_number`.execute(privileged())).rows;
}
function tables(node: SnapshotNode): string[] {
  return Object.entries(node.children).flatMap(([table, entries]) => [table, ...entries.flatMap(tables)]);
}

describe("published snapshots against PostgreSQL", () => {
  beforeAll(openScratch, 120_000);
  afterAll(closeScratch);

  test("a version never embeds earlier versions, so identical content hashes identically", async () => {
    const { context } = platformFor(editor);
    const ids = await seedTemplate();
    for (let publish = 0; publish < 3; publish += 1) await publishTemplate(context, ids.template);
    const stored = await versions(ids.template);
    expect(stored.map((row) => row.version_number)).toEqual([1, 2, 3]);

    const third = parseSnapshot(stored[2]!.snapshot);
    expect(third.entity).toBe("Template");
    expect(tables(third.head)).toEqual(["template_variants", "blocks"]);
    expect(JSON.stringify(third)).not.toContain("template_versions");
    // Nothing about the head changed between publishes, so every snapshot is the same content.
    expect(new Set(stored.map((row) => row.content_hash)).size).toBe(1);
    expect(JSON.stringify(stored[2]!.snapshot).length).toBe(JSON.stringify(stored[0]!.snapshot).length);

    // Content that does change hashes differently, and identical content republished hashes the same again.
    await sql`update erp.blocks set "values" = '{"text":"Changed"}'::jsonb where id = ${ids.second}::uuid`.execute(privileged());
    await publishTemplate(context, ids.template);
    await sql`update erp.blocks set "values" = '{"text":"Second"}'::jsonb where id = ${ids.second}::uuid`.execute(privileged());
    await publishTemplate(context, ids.template);
    const hashes = (await versions(ids.template)).map((row) => row.content_hash);
    expect(hashes[3]).not.toBe(hashes[0]);
    expect(hashes[4]).toBe(hashes[0]);
  });
});
