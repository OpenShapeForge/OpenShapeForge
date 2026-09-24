// SPDX-License-Identifier: BUSL-1.1
/**
 * Document-theme default switching, new-template fill, tenant isolation, and
 * live token resolution against a throwaway scratch database.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/db/__tests__/document-themes.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import type { ModuleOperationContext } from "@openshapeforge/plugin-runtime";
import { resolveDocumentTheme, setDefaultDocumentTheme } from "@openshapeforge/documents/runtime";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { jsonbLiteral } from "../sql-helpers.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const TEST_TIMEOUT = 90_000;
const typography = {
  body: { fontSize: 11, lineHeight: 1.5, fontWeight: 400, colorRole: "text" },
  heading1: { fontSize: 22, lineHeight: 1.25, fontWeight: 700, colorRole: "text" },
  heading2: { fontSize: 16, lineHeight: 1.3, fontWeight: 700, colorRole: "text" },
  heading3: { fontSize: 13, lineHeight: 1.35, fontWeight: 700, colorRole: "text" },
  quote: { fontSize: 11, lineHeight: 1.5, fontWeight: 400, colorRole: "text", spaceBefore: 8 },
  list: { fontSize: 11, lineHeight: 1.5, fontWeight: 400, colorRole: "text", spaceBefore: 4 },
};

async function withScratchDb<T>(fn: (db: Kysely<DB>) => Promise<T>): Promise<T> {
  const name = `document_themes_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unsafe scratch database name: ${name}`);
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") throw new Error("admin URL must not point at openshapeforge_dev");
  url.pathname = `/${name}`;
  const admin = new SQL(ADMIN_URL, { max: 1 });
  try {
    await admin.unsafe(`create database "${name}"`);
    const runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 4 });
    try {
      await runtime.db.connection().execute((conn) => runMigrationChain(conn));
      return await fn(runtime.db);
    } finally {
      await runtime.close();
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
    }
  } finally {
    await admin.close();
  }
}

function sqlState(error: unknown): string | undefined {
  const postgres = error as { errno?: string; code?: string } | null;
  return postgres?.errno ?? postgres?.code;
}

async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return error;
  }
}

async function insertTheme(db: Kysely<DB>, tenant: string, key: string, opts: { isDefault?: boolean; color?: string } = {}) {
  const id = randomUUID();
  await sql`
    insert into erp.document_themes (
      id, tenant_id, key, name, is_default, surface_color, text_color, accent_color, font_family, typography
    ) values (
      ${id}::uuid, ${tenant}::uuid, ${key}, ${key}, ${opts.isDefault ?? false},
      ${opts.color ?? "#ffffff"}, '#111827', '#2563eb', 'dm-sans', ${jsonbLiteral(typography)}
    )
  `.execute(db);
  return id;
}

function resolveContext(db: Kysely<DB>, tenantId: string): ModuleOperationContext {
  return {
    transport: "operation",
    session: { tenantId, userId: tenantId, credential: "bearer", roles: ["Organization.All.ReadWrite"], groups: [], scope: "tenant" },
    platform: {
      records: { assertAccess: async () => undefined },
      db: { withSession: async (_session: unknown, work: (trx: unknown) => Promise<unknown>) => db.transaction().execute(work) },
    },
  } as unknown as ModuleOperationContext;
}

describe("document theme invariants", () => {
  test("one default per tenant, new templates inherit it, and live resolve follows token edits", async () => {
    await withScratchDb(async (db) => {
      const tenantA = randomUUID();
      const tenantB = randomUUID();
      const first = await insertTheme(db, tenantA, "first");
      const firstRow = await sql<{ is_default: boolean }>`select is_default from erp.document_themes where id = ${first}::uuid`.execute(db);
      expect(firstRow.rows[0]?.is_default).toBe(true);

      const second = await insertTheme(db, tenantA, "second", { isDefault: true, color: "#ff0000" });
      const ctx = resolveContext(db, tenantA);
      await setDefaultDocumentTheme({ id: second }, ctx);
      const flags = await sql<{ key: string; is_default: boolean }>`
        select key, is_default from erp.document_themes where tenant_id = ${tenantA}::uuid order by key
      `.execute(db);
      expect(flags.rows).toEqual([
        { key: "first", is_default: false },
        { key: "second", is_default: true },
      ]);

      const other = await insertTheme(db, tenantB, "other", { color: "#00ff00" });
      expect(sqlState(await rejection(insertTheme(db, tenantA, "second")))?.startsWith("23")).toBe(true);

      const unset = await rejection(sql`update erp.document_themes set is_default = false where id = ${second}::uuid`.execute(db));
      expect(String((unset as { message?: string } | undefined)?.message ?? unset)).toContain("VALIDATION:");

      const templateId = randomUUID();
      await sql`
        insert into erp.templates (id, tenant_id, key, name)
        values (${templateId}::uuid, ${tenantA}::uuid, 'letter', 'Letter')
      `.execute(db);
      const filled = await sql<{ document_theme_id: string }>`
        select document_theme_id from erp.templates where id = ${templateId}::uuid
      `.execute(db);
      expect(filled.rows[0]?.document_theme_id).toBe(second);

      expect(sqlState(await rejection(sql`
        insert into erp.templates (id, tenant_id, key, name, document_theme_id)
        values (${randomUUID()}::uuid, ${tenantA}::uuid, 'stolen', 'Stolen', ${other}::uuid)
      `.execute(db)))?.startsWith("23")).toBe(true);

      const emptyTenant = randomUUID();
      const bare = randomUUID();
      await sql`
        insert into erp.templates (id, tenant_id, key, name)
        values (${bare}::uuid, ${emptyTenant}::uuid, 'bare', 'Bare')
      `.execute(db);
      const missing = await sql<{ document_theme_id: string | null }>`
        select document_theme_id from erp.templates where id = ${bare}::uuid
      `.execute(db);
      expect(missing.rows[0]?.document_theme_id).toBeNull();

      const before = await resolveDocumentTheme({ templateId }, ctx) as { value: { theme: { id: string; surfaceColor: string }; resolution: { kind: string } } };
      expect(before.value.theme).toMatchObject({ id: second, surfaceColor: "#ff0000" });
      expect(before.value.resolution.kind).toBe("template");

      await sql`update erp.document_themes set surface_color = '#0000aa' where id = ${second}::uuid`.execute(db);
      const after = await resolveDocumentTheme({ templateId }, ctx) as { value: { theme: { surfaceColor: string } } };
      expect(after.value.theme.surfaceColor).toBe("#0000aa");

      const third = await insertTheme(db, tenantA, "third", { color: "#abcdef" });
      const prematureDelete = await rejection(sql`delete from erp.document_themes where id = ${second}::uuid`.execute(db));
      expect(String((prematureDelete as { message?: string } | undefined)?.message ?? prematureDelete)).toContain("choose another default");
      await sql`update erp.templates set document_theme_id = ${third}::uuid where id = ${templateId}::uuid`.execute(db);
      await setDefaultDocumentTheme({ id: third }, ctx);
      await sql`delete from erp.document_themes where id = ${second}::uuid`.execute(db);
      const promoted = await sql<{ key: string }>`
        select key from erp.document_themes where tenant_id = ${tenantA}::uuid and is_default
      `.execute(db);
      expect(promoted.rows).toEqual([{ key: "third" }]);
      const kept = await resolveDocumentTheme({ templateId }, ctx) as { value: { theme: { id: string; surfaceColor: string }; resolution: { kind: string } } };
      expect(kept.value.resolution.kind).toBe("template");
      expect(kept.value.theme).toMatchObject({ id: third, surfaceColor: "#abcdef" });

      const isolated = await rejection(Promise.resolve(resolveDocumentTheme({ templateId }, resolveContext(db, tenantB))));
      expect(isolated).toMatchObject({ operationError: { code: "NOT_FOUND" } });

      const firstConcurrentTenant = randomUUID();
      await Promise.all([
        insertTheme(db, firstConcurrentTenant, "concurrent-a"),
        insertTheme(db, firstConcurrentTenant, "concurrent-b"),
      ]);
      const concurrentDefaults = await sql<{ count: number }>`
        select count(*)::int as count from erp.document_themes
        where tenant_id = ${firstConcurrentTenant}::uuid and is_default
      `.execute(db);
      expect(concurrentDefaults.rows[0]?.count).toBe(1);

      await Promise.all([
        setDefaultDocumentTheme({ id: first }, ctx),
        setDefaultDocumentTheme({ id: third }, ctx),
      ]);
      const afterSwitches = await sql<{ id: string }>`
        select id from erp.document_themes where tenant_id = ${tenantA}::uuid and is_default
      `.execute(db);
      expect(afterSwitches.rows).toHaveLength(1);
      expect(afterSwitches.rows[0]?.id === first || afterSwitches.rows[0]?.id === third).toBe(true);
      const deleteDefault = await rejection(sql`delete from erp.document_themes where id = ${afterSwitches.rows[0]?.id}::uuid`.execute(db));
      expect(String((deleteDefault as { message?: string } | undefined)?.message ?? deleteDefault)).toContain("choose another default");
    });
  }, TEST_TIMEOUT);
});
