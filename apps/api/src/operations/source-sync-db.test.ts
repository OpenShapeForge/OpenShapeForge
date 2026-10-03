// SPDX-License-Identifier: BUSL-1.1
/**
 * The source-sync Operations against PostgreSQL, on a scratch database built
 * from the bundled manifest and driven through the restricted app role: a
 * page of ledger records from one source lands once and is updated in place,
 * references by externalId resolve within the same source, a page is all or
 * nothing, an older replay never overwrites newer data, the watermark is read
 * back from the data, and the target entity's own roles decide.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { createDatabaseRuntime, type DatabaseRuntime } from "../db/connection.js";
import { runMigrationChain } from "../db/migration-chain.js";
import { APP_ROLE, DEV_APP_ROLE_PASSWORD_DEFAULT } from "../db/migrations/app-role.js";
import type { ModuleOperationHandler } from "../modules/contract.js";
import { executeBinding } from "../mcp/declarative-execution.js";
import { sinceFromSourceVersion, sourceSyncOperationHandler } from "./source-sync-operations.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const scratchName = `source_sync_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const FINANCE = ["Finance.All.Read", "Finance.All.ReadWrite"];
const SOURCE = { sourceAuthority: "acme-erp", sourceAdministration: "01" };
let admin: SQL, privileged: DatabaseRuntime, restricted: DatabaseRuntime;

function scratchUrl(role?: { username: string; password: string }): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev" || url.pathname === "/hubble_dev") throw new Error("admin URL must not point at an application database");
  if (role) { url.username = role.username; url.password = role.password; }
  url.pathname = `/${scratchName}`;
  return url.toString();
}

const sessionFor = (tenantId: string, roles = FINANCE) =>
  ({ tenantId, userId: randomUUID(), roles, groups: [], scope: "tenant", credential: "bearer" }) as unknown as TrustedSessionContext;

async function run(handler: string, input: Record<string, unknown>, session: TrustedSessionContext): Promise<any> {
  const context = { db: restricted.db, session, transport: "operation" } as unknown as Parameters<ModuleOperationHandler>[1];
  const result = await sourceSyncOperationHandler({ key: handler, handler })(input, context);
  return (result as { value: unknown }).value;
}

async function tenant(): Promise<string> {
  const id = randomUUID();
  await sql`insert into platform.tenants (id, slug, name, status) values (${id}::uuid, ${`sync-${id.slice(0, 8)}`}, 'Sync tenant', 'active')`.execute(privileged.db);
  return id;
}

const account = (externalId: string, code: string, version: number, name = `Account ${code}`) => ({
  externalId, code, name, accountType: "asset", isPostable: true, currencyCode: "EUR",
  sourceVersion: String(version).padStart(20, "0"),
});

async function rows(table: string, tenantId: string) {
  return (await sql<{ external_id: string; name?: string; ledger_account_id?: string; ledger_posting_id?: string }>`
    select * from ${sql.id("erp", table)} where tenant_id = ${tenantId}::uuid order by external_id`.execute(privileged.db)).rows;
}

describe("source-sync Operations", () => {
  beforeAll(async () => {
    admin = new SQL(ADMIN_URL, { max: 1 });
    await admin.unsafe(`create database "${scratchName}"`);
    privileged = createDatabaseRuntime({ databaseUrl: scratchUrl(), maxConnections: 2 });
    await privileged.db.connection().execute((conn) => runMigrationChain(conn));
    restricted = createDatabaseRuntime({
      databaseUrl: scratchUrl({ username: APP_ROLE, password: process.env.OPENSHAPEFORGE_APP_PASSWORD ?? DEV_APP_ROLE_PASSWORD_DEFAULT }),
      maxConnections: 4,
    });
  }, 120_000);

  afterAll(async () => {
    await restricted?.close();
    await privileged?.close();
    await admin?.unsafe(`drop database if exists "${scratchName}" with (force)`);
    await admin?.close();
  });

  test("creates a page once, updates it in place, and resumes from the highest version", async () => {
    const tenantId = await tenant(), session = sessionFor(tenantId);
    const first = await run("upsertBySource", { entity: "LedgerAccount", ...SOURCE, records: [account("a1", "1000", 7), account("a2", "8000", 9)] }, session);
    expect(first).toEqual({ created: 2, updated: 0, skipped: 0, highestSourceVersion: "00000000000000000009" });
    const again = await run("upsertBySource", { entity: "LedgerAccount", ...SOURCE, records: [account("a1", "1000", 12, "Kas")] }, session);
    expect(again).toMatchObject({ created: 0, updated: 1 });
    expect((await rows("ledger_accounts", tenantId)).map((row) => [row.external_id, row.name])).toEqual([["a1", "Kas"], ["a2", "Account 8000"]]);
    expect(await run("sourceWatermark", { entity: "LedgerAccount", ...SOURCE, initial: "1" }, session))
      .toEqual({ since: "12", sourceVersion: "00000000000000000012" });
  });

  test("never lets an older replay overwrite newer data", async () => {
    const tenantId = await tenant(), session = sessionFor(tenantId);
    await run("upsertBySource", { entity: "LedgerAccount", ...SOURCE, records: [account("a1", "1000", 20, "Newer")] }, session);
    const replay = await run("upsertBySource", { entity: "LedgerAccount", ...SOURCE, records: [account("a1", "1000", 5, "Older")] }, session);
    expect(replay).toMatchObject({ updated: 0, skipped: 1 });
    expect((await rows("ledger_accounts", tenantId))[0]?.name).toBe("Newer");
  });

  test("resolves references by externalId within the same source", async () => {
    const tenantId = await tenant(), session = sessionFor(tenantId);
    await run("upsertBySource", { entity: "LedgerAccount", ...SOURCE, records: [account("a1", "1000", 1)] }, session);
    await run("upsertBySource", {
      entity: "LedgerPosting", ...SOURCE,
      records: [{ externalId: "e1", postingDate: "2026-09-26", status: "posted", sourceType: "acme-erp", sourceVersion: "2" }],
    }, session);
    await run("upsertBySource", {
      entity: "LedgerPostingLine", ...SOURCE,
      records: [{ externalId: "l1", lineNumber: 1, side: "debit", amount: 121.5, ledgerAccountExternalId: "a1", ledgerPostingExternalId: "e1", relationExternalId: null }],
    }, session);
    const [line] = await rows("ledger_posting_lines", tenantId);
    const [ledgerAccount] = await sql<{ id: string }>`select id::text from erp.ledger_accounts where tenant_id = ${tenantId}::uuid`.execute(privileged.db).then((result) => result.rows);
    expect(line?.ledger_account_id).toBe(ledgerAccount!.id);
    expect(line?.ledger_posting_id).toBeTruthy();
  });

  test("writes nothing of a page when one record fails", async () => {
    const tenantId = await tenant(), session = sessionFor(tenantId);
    await expect(run("upsertBySource", {
      entity: "LedgerPostingLine", ...SOURCE,
      records: [
        { externalId: "l1", lineNumber: 1, side: "debit", amount: 1 },
        { externalId: "l2", lineNumber: 2, side: "credit", amount: 1, ledgerAccountExternalId: "missing" },
      ],
    }, session)).rejects.toMatchObject({ operationError: { code: "BAD_USER_INPUT" } });
    expect(await rows("ledger_posting_lines", tenantId)).toEqual([]);
  });

  test("keeps tenants and administrations apart, and lets the entity's roles decide", async () => {
    const tenantA = await tenant(), tenantB = await tenant();
    await run("upsertBySource", { entity: "LedgerAccount", ...SOURCE, records: [account("a1", "1000", 1)] }, sessionFor(tenantA));
    const other = await run("upsertBySource", { entity: "LedgerAccount", ...SOURCE, records: [account("a1", "1000", 1)] }, sessionFor(tenantB));
    expect(other).toMatchObject({ created: 1 });
    const otherAdministration = { ...SOURCE, sourceAdministration: "02" };
    expect(await run("sourceWatermark", { entity: "LedgerAccount", ...otherAdministration }, sessionFor(tenantA)))
      .toEqual({ since: null, sourceVersion: null });
    await expect(run("upsertBySource", { entity: "LedgerAccount", ...SOURCE, records: [account("a9", "9", 1)] }, sessionFor(tenantA, ["Finance.All.Read"])))
      .rejects.toMatchObject({ operationError: { code: "FORBIDDEN" } });
  });

  test("removes what the source deleted and treats an unknown id as already gone", async () => {
    const tenantId = await tenant(), session = sessionFor(tenantId);
    await run("upsertBySource", { entity: "LedgerAccount", ...SOURCE, records: [account("a1", "1000", 1), account("a2", "2000", 2)] }, session);
    expect(await run("removeBySource", { entity: "LedgerAccount", ...SOURCE, externalIds: ["a1", "never-imported"] }, session)).toEqual({ removed: 1 });
    expect((await rows("ledger_accounts", tenantId)).map((row) => row.external_id)).toEqual(["a2"]);
  });

  test("reads one watermark across entities one source read returns together", async () => {
    const tenantId = await tenant(), session = sessionFor(tenantId);
    await run("upsertBySource", {
      entity: "LedgerPosting", ...SOURCE,
      records: [{ externalId: "e1", postingDate: "2026-09-26", status: "posted", sourceType: "acme-erp", sourceVersion: "00000000000000000030" }],
    }, session);
    await run("upsertBySource", {
      entity: "LedgerPostingLine", ...SOURCE,
      records: [{ externalId: "l1", lineNumber: 1, side: "debit", amount: 1, ledgerPostingExternalId: "e1", sourceVersion: "00000000000000000021" }],
    }, session);
    expect(await run("sourceWatermark", { entity: ["LedgerPosting", "LedgerPostingLine"], ...SOURCE, initial: "1" }, session))
      .toEqual({ since: "30", sourceVersion: "00000000000000000030" });
  });

  test("removes from a mixed list of deletions only those of its own entity", async () => {
    const tenantId = await tenant(), session = sessionFor(tenantId);
    await run("upsertBySource", { entity: "LedgerAccount", ...SOURCE, records: [account("a1", "1000", 1), account("a2", "2000", 2)] }, session);
    const deletions = [
      { externalId: "a1", entity: "LedgerAccount" },
      { externalId: "a2", entity: "Relation" },
      { externalId: "x9", entity: null },
    ];
    expect(await run("removeBySource", { entity: "LedgerAccount", ...SOURCE, records: deletions }, session)).toEqual({ removed: 1 });
    expect((await rows("ledger_accounts", tenantId)).map((row) => row.external_id)).toEqual(["a2"]);
    await expect(run("removeBySource", { entity: "LedgerAccount", ...SOURCE }, session))
      .rejects.toMatchObject({ operationError: { code: "BAD_USER_INPUT" } });
  });

  test("reads the next since without the padding", () => {
    expect([sinceFromSourceVersion("00000000000000000123"), sinceFromSourceVersion("0"), sinceFromSourceVersion("2026-09-26T10:00:00.000Z"), sinceFromSourceVersion(null)])
      .toEqual(["123", "0", "2026-09-26T10:00:00.000Z", null]);
  });
  test("related batches roll back the header and watermark when a line fails, then retry safely", async () => {
    const tenantId = await tenant(), session = sessionFor(tenantId);
    const posting = { externalId: "old", postingDate: "2026-09-26", status: "posted", sourceType: "acme-erp", sourceVersion: "00000000000000000010" };
    await run("upsertBySource", { entity: "LedgerPosting", ...SOURCE, records: [posting] }, session);
    const page = { ...SOURCE, batches: [
      { entity: "LedgerPosting", action: "upsert", records: [{ ...posting, externalId: "new", sourceVersion: "00000000000000000020" }] },
      { entity: "LedgerPostingLine", action: "upsert", records: [{ externalId: "line", lineNumber: 1, side: "debit", amount: 1,
        ledgerPostingExternalId: "new", ledgerAccountExternalId: "missing", sourceVersion: "00000000000000000019" }] },
    ] };
    await expect(run("applySourcePage", page, session)).rejects.toMatchObject({ operationError: { code: "BAD_USER_INPUT" } });
    expect((await rows("ledger_postings", tenantId)).map((row) => row.external_id)).toEqual(["old"]);
    expect(await rows("ledger_posting_lines", tenantId)).toEqual([]);
    expect((await run("sourceWatermark", { entity: ["LedgerPosting", "LedgerPostingLine"], ...SOURCE }, session)).since).toBe("10");
    await run("upsertBySource", { entity: "LedgerAccount", ...SOURCE, records: [account("missing", "1000", 1)] }, session);
    await run("applySourcePage", page, session);
    await run("applySourcePage", page, session);
    expect(await rows("ledger_postings", tenantId)).toHaveLength(2);
    expect(await rows("ledger_posting_lines", tenantId)).toHaveLength(1);
    expect((await run("sourceWatermark", { entity: ["LedgerPosting", "LedgerPostingLine"], ...SOURCE }, session)).since).toBe("20");
  });

  test("a deletion found only after 1000 records is removed, and replay is idempotent", async () => {
    const tenantId = await tenant(), session = sessionFor(tenantId);
    await run("upsertBySource", { entity: "LedgerAccount", ...SOURCE, records: [account("second-page", "1000", 1)] }, session);
    let calls = 0;
    const deletionRead = await executeBinding({
      binding: {}, providerRow: { transport: "rest", baseUrlTemplate: "https://erp.example", egressHosts: ["erp.example"] },
      connectionValues: {}, serviceInputs: {}, secretScope: "unused",
      operationRow: { kind: "query", operation: { method: "GET", pathTemplate: "/deleted" },
        pagination: { mode: "all", style: "nextLink", cursorPath: "d.__next" },
        responseMapping: { rootPath: "d.results", fieldPaths: [{ field: "records", path: "$" }] } },
      fetchImpl: (async (url: unknown) => {
        calls++;
        return Response.json(String(url).includes("page=2")
          ? { d: { results: [{ externalId: "second-page", entity: "LedgerAccount" }] } }
          : { d: { results: Array.from({ length: 1000 }, (_, i) => ({ externalId: `absent-${i}`, entity: "LedgerAccount" })), __next: "?page=2" } });
      }) as typeof fetch,
    });
    const page = { ...SOURCE, batches: [{ entity: "LedgerAccount", action: "remove", records: deletionRead.records }] };
    await run("applySourcePage", page, session);
    await run("applySourcePage", page, session);
    expect(calls).toBe(2);
    expect(await rows("ledger_accounts", tenantId)).toEqual([]);
  });

  test("atomic pages retain entity authorization and tenant isolation", async () => {
    const tenantId = await tenant();
    const page = { ...SOURCE, batches: [{ entity: "LedgerAccount", action: "upsert", records: [account("a", "1000", 1)] }] };
    await expect(run("applySourcePage", page, sessionFor(tenantId, ["Finance.All.Read"])))
      .rejects.toMatchObject({ operationError: { code: "FORBIDDEN" } });
    expect(await rows("ledger_accounts", tenantId)).toEqual([]);
    await run("applySourcePage", page, sessionFor(tenantId));
    const other = await tenant();
    await run("applySourcePage", { ...SOURCE, batches: [{ entity: "LedgerAccount", action: "remove", records: [{ externalId: "a" }] }] }, sessionFor(other));
    expect(await rows("ledger_accounts", tenantId)).toHaveLength(1);
  });

});
