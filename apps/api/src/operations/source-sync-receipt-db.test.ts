// SPDX-License-Identifier: BUSL-1.1
/**
 * The optional page receipt of `source-sync.apply-page` against PostgreSQL, on
 * a scratch database built from the bundled manifest and driven through the
 * restricted app role.
 *
 * The case it exists for: an import step posts a page of ledger headers and
 * lines, the page commits, and the step never sees the response — the job is
 * restarted, the connection drops. Without a receipt its only options are to
 * skip a page that may not have landed or to post one that did; the receipt
 * lets it post the same page again and be handed the committed result instead
 * of a second set of journal writes.
 *
 * What is proven here: the receipt and the ledger writes commit or roll back
 * together, the key is bound to the tenant, the actor, the source
 * administration and the page exactly as submitted, a different page under the
 * same key is refused rather than applied, duplicate submissions serialize on
 * the receipt's transaction lock, and a stored result is disclosed only to a
 * caller that still has read authority on the entities in the page. Keyless
 * callers keep their receipt-free contract. No provider is contacted; all data
 * is synthetic.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { operationErrorOf } from "@openshapeforge/operations";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { createDatabaseRuntime, type DatabaseRuntime } from "../db/connection.js";
import { runMigrationChain } from "../db/migration-chain.js";
import { APP_ROLE, DEV_APP_ROLE_PASSWORD_DEFAULT } from "../db/migrations/app-role.js";
import type { ModuleOperationHandler } from "../modules/contract.js";
import { getGeneratedCrudTables } from "./entity/catalog.js";
import { sourceSyncOperationHandler } from "./source-sync-operations.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL
  ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
if (decodeURIComponent(new URL(ADMIN_URL).pathname).toLowerCase().endsWith("_dev")) {
  throw new Error("admin URL must not point at an application database");
}
const TEST_TIMEOUT = 120_000;
const scratchName = `source_sync_receipt_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const FINANCE = ["Finance.All.Read", "Finance.All.ReadWrite"];
const SOURCE = { sourceAuthority: "acme-erp", sourceAdministration: "01" };

let admin: SQL, privileged: DatabaseRuntime, restricted: DatabaseRuntime;

function scratchUrl(role?: { username: string; password: string }): string {
  const url = new URL(ADMIN_URL);
  if (role) { url.username = role.username; url.password = role.password; }
  url.pathname = `/${scratchName}`;
  return url.toString();
}

/**
 * One verified actor. The receipt is actor-scoped, so a retry has to present
 * the same userId to find it at all — every helper here takes the session
 * rather than minting one.
 */
const sessionFor = (tenantId: string, userId: string, roles = FINANCE): TrustedSessionContext =>
  ({ tenantId, userId, roles, groups: [], relationGroupIds: [], scope: "tenant", credential: "bearer" });

async function run(handler: string, input: Record<string, unknown>, session: TrustedSessionContext): Promise<any> {
  const context = { db: restricted.db, session, transport: "operation" } as unknown as Parameters<ModuleOperationHandler>[1];
  const result = await sourceSyncOperationHandler({ key: handler, handler })(input, context);
  return (result as { value: unknown }).value;
}

async function tenant(): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into platform.tenants (id, slug, name, status)
    values (${id}::uuid, ${`receipt-${id.slice(0, 8)}`}, 'Receipt tenant', 'active')
  `.execute(privileged.db);
  return id;
}

/** Rows of one ledger table for a tenant, read past RLS for assertions only. */
async function ledger(table: string, tenantId: string) {
  return (await sql<{ external_id: string; source_version: string | null }>`
    select external_id, source_version from ${sql.id("erp", table)}
     where tenant_id = ${tenantId}::uuid order by external_id
  `.execute(privileged.db)).rows;
}

async function receipts(tenantId: string) {
  return (await sql<{ state: string; actor_id: string }>`
    select state, actor_id::text as actor_id from platform.operation_execution_receipts
     where tenant_id = ${tenantId}::uuid order by key_hash
  `.execute(privileged.db)).rows;
}

const account = (externalId: string, code: string, version: number) => ({
  externalId, code, name: `Account ${code}`, accountType: "asset", isPostable: true,
  currencyCode: "EUR", sourceVersion: String(version).padStart(20, "0"),
});

const header = (externalId: string, version: number) => ({
  externalId, postingDate: "2026-11-21", status: "posted", sourceType: "acme-erp",
  sourceVersion: String(version).padStart(20, "0"),
});

const line = (externalId: string, postingExternalId: string, accountExternalId: string, amount: number) => ({
  externalId, lineNumber: 1, side: "debit", amount,
  ledgerPostingExternalId: postingExternalId, ledgerAccountExternalId: accountExternalId,
  sourceVersion: "00000000000000000040",
});

/** A journal page as an import step submits it: account, header, then its lines. */
function journalPage(
  options: { effectKey?: string; administration?: string; accountExternalId?: string; amount?: number } = {},
) {
  const page: Record<string, unknown> = {
    ...SOURCE,
    ...(options.administration ? { sourceAdministration: options.administration } : {}),
    batches: [
      { entity: "LedgerAccount", action: "upsert", records: [account("a1", "1000", 10)] },
      { entity: "LedgerPosting", action: "upsert", records: [header("e1", 20)] },
      { entity: "LedgerPostingLine", action: "upsert",
        records: [line("l1", "e1", options.accountExternalId ?? "a1", options.amount ?? 121.5)] },
    ],
  };
  if (options.effectKey !== undefined) page.effectKey = options.effectKey;
  return page;
}

function expectCode(error: unknown, code: string): void {
  expect(operationErrorOf(error)?.code).toBe(code);
}

async function refusal(promise: Promise<unknown>, code: string): Promise<void> {
  const outcome = await promise.then(() => undefined, (error: unknown) => ({ error }));
  if (!outcome) throw new Error(`expected a ${code} refusal, but the call succeeded`);
  expectCode(outcome.error, code);
}

describe("source-sync page receipts", () => {
  beforeAll(async () => {
    admin = new SQL(ADMIN_URL, { max: 1 });
    await admin.unsafe(`create database "${scratchName}"`);
    privileged = createDatabaseRuntime({ databaseUrl: scratchUrl(), maxConnections: 3 });
    await privileged.db.connection().execute((connection) => runMigrationChain(connection));
    restricted = createDatabaseRuntime({
      databaseUrl: scratchUrl({
        username: APP_ROLE,
        password: process.env.OPENSHAPEFORGE_APP_PASSWORD ?? DEV_APP_ROLE_PASSWORD_DEFAULT,
      }),
      maxConnections: 4,
    });
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await restricted?.close();
    await privileged?.close();
    await admin?.unsafe(`drop database if exists "${scratchName}" with (force)`);
    await admin?.close();
  });

  test("resumes a committed page whose result was lost, without writing the journal twice", async () => {
    const tenantId = await tenant();
    const session = sessionFor(tenantId, randomUUID());
    const page = journalPage({ effectKey: "exact-online-page-1" });

    const applied = await run("applySourcePage", page, session);
    expect(applied.batches.map((batch: any) => [batch.entity, batch.chunks[0].created])).toEqual([
      ["LedgerAccount", 1], ["LedgerPosting", 1], ["LedgerPostingLine", 1],
    ]);

    // The step never saw the response above: it retries the identical page. A
    // re-execution would report the header as `updated`, so `created` coming
    // back a second time is the committed receipt, not a second write.
    const resumed = await run("applySourcePage", page, session);
    expect(resumed).toEqual(applied);

    expect((await ledger("ledger_postings", tenantId)).map((row) => row.external_id)).toEqual(["e1"]);
    expect((await ledger("ledger_posting_lines", tenantId)).map((row) => row.external_id)).toEqual(["l1"]);
    expect(await receipts(tenantId)).toEqual([{ state: "completed", actor_id: session.userId! }]);
    expect((await run("sourceWatermark", { entity: ["LedgerPosting", "LedgerPostingLine"], ...SOURCE }, session)).since)
      .toBe("40");
  }, TEST_TIMEOUT);

  test("refuses a different page under a key already used, and applies none of it", async () => {
    const tenantId = await tenant();
    const session = sessionFor(tenantId, randomUUID());
    await run("applySourcePage", journalPage({ effectKey: "page-2" }), session);

    // A different amount is a different page, however small the difference.
    await refusal(
      run("applySourcePage", journalPage({ effectKey: "page-2", amount: 200 }), session),
      "IDEMPOTENCY_KEY_REUSED",
    );

    // Batch order is part of the page: the same records applied the other way
    // round are a different request, not the same one spelled differently.
    const reordered = journalPage({ effectKey: "page-2" });
    reordered.batches = [...(reordered.batches as unknown[])].reverse();
    await refusal(run("applySourcePage", reordered, session), "IDEMPOTENCY_KEY_REUSED");

    expect((await ledger("ledger_posting_lines", tenantId)).map((row) => row.external_id)).toEqual(["l1"]);
    expect(await receipts(tenantId)).toHaveLength(1);
  }, TEST_TIMEOUT);

  test("a rolled-back page leaves no receipt, so the key still names the page that lands", async () => {
    const tenantId = await tenant();
    const session = sessionFor(tenantId, randomUUID());

    // The line references an account this source never imported: the page fails
    // after the receipt was claimed, inside the same transaction.
    await refusal(
      run("applySourcePage", journalPage({ effectKey: "page-3", accountExternalId: "absent" }), session),
      "BAD_USER_INPUT",
    );
    expect(await ledger("ledger_postings", tenantId)).toEqual([]);
    expect(await ledger("ledger_posting_lines", tenantId)).toEqual([]);
    expect(await receipts(tenantId)).toEqual([]);

    const corrected = await run("applySourcePage", journalPage({ effectKey: "page-3" }), session);
    expect(corrected.batches[1].chunks[0].created).toBe(1);
    expect(await receipts(tenantId)).toEqual([{ state: "completed", actor_id: session.userId! }]);
  }, TEST_TIMEOUT);

  test("serializes duplicate submissions of one key on the receipt's transaction lock", async () => {
    const tenantId = await tenant();
    const session = sessionFor(tenantId, randomUUID());
    const page = journalPage({ effectKey: "page-4" });

    // Hold a source lock the page takes AFTER claiming its receipt, so the
    // first submission is provably still inside its transaction while the
    // second arrives. The key is the one source-sync locks on; the lock order
    // is by table name, so the accounts batch is the page's first wait.
    const accounts = getGeneratedCrudTables()
      .find((table) => table.source?.authoringEntityName === "LedgerAccount")!;
    const sourceLockKey = JSON.stringify([
      "source-sync", tenantId, accounts.name, SOURCE.sourceAuthority, SOURCE.sourceAdministration,
    ]);
    const locker = new SQL(scratchUrl(), { max: 1 });
    try {
      await locker`select pg_advisory_lock(hashtextextended(${sourceLockKey}, 0))`;
      const first = run("applySourcePage", page, session);
      const blocked = async () => (await sql<{ waiting: number }>`
        select count(*)::int as waiting from pg_locks
         where locktype = 'advisory' and not granted
           and database = (select oid from pg_database where datname = current_database())
      `.execute(privileged.db)).rows[0]!.waiting;
      // Inside the session's statement timeout: the wait itself is one
      // statement, and a submission aborted by the clock proves nothing.
      const deadline = Date.now() + 10_000;
      while (await blocked() === 0) {
        if (Date.now() > deadline) throw new Error("the first submission never reached the source lock");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      await refusal(run("applySourcePage", page, session), "OPERATION_IN_PROGRESS");
      expect(await ledger("ledger_postings", tenantId)).toEqual([]);

      await locker`select pg_advisory_unlock(hashtextextended(${sourceLockKey}, 0))`;
      const applied = await first;
      expect(applied.batches[1].chunks[0].created).toBe(1);
      expect(await run("applySourcePage", page, session)).toEqual(applied);
    } finally {
      await locker.close();
    }

    expect((await ledger("ledger_postings", tenantId)).map((row) => row.external_id)).toEqual(["e1"]);
    expect((await ledger("ledger_posting_lines", tenantId)).map((row) => row.external_id)).toEqual(["l1"]);
    expect(await receipts(tenantId)).toHaveLength(1);
  }, TEST_TIMEOUT);

  test("binds one key to its own administration, tenant and actor", async () => {
    const tenantId = await tenant();
    const userId = randomUUID();
    const session = sessionFor(tenantId, userId);
    await run("applySourcePage", journalPage({ effectKey: "shared" }), session);

    // The same key for another administration of the same source is another
    // effect: its own page lands, under its own receipt.
    const other = await run("applySourcePage", journalPage({ effectKey: "shared", administration: "02" }), session);
    expect(other.batches[1].chunks[0].created).toBe(1);
    expect((await ledger("ledger_postings", tenantId)).map((row) => row.external_id)).toEqual(["e1", "e1"]);
    expect(await receipts(tenantId)).toHaveLength(2);

    // Another tenant's import under the same key sees none of this.
    const elsewhere = await tenant();
    const across = await run("applySourcePage", journalPage({ effectKey: "shared" }), sessionFor(elsewhere, userId));
    expect(across.batches[1].chunks[0].created).toBe(1);
    expect(await receipts(elsewhere)).toHaveLength(1);
    expect(await receipts(tenantId)).toHaveLength(2);

    // And another actor in the same tenant cannot resume this one's page: its
    // own submission is a fresh effect, which the source identity then matches.
    const stranger = await run("applySourcePage", journalPage({ effectKey: "shared" }), sessionFor(tenantId, randomUUID()));
    expect(stranger.batches[1].chunks[0]).toMatchObject({ created: 0, updated: 1 });
    expect(await receipts(tenantId)).toHaveLength(3);
  }, TEST_TIMEOUT);

  test("discloses a stored result only to a caller that still has read authority", async () => {
    const tenantId = await tenant();
    const userId = randomUUID();
    const applied = await run("applySourcePage", journalPage({ effectKey: "page-6" }), sessionFor(tenantId, userId));

    // Read authority is enough to be handed back what this actor already wrote.
    expect(await run("applySourcePage", journalPage({ effectKey: "page-6" }), sessionFor(tenantId, userId, ["Finance.All.Read"])))
      .toEqual(applied);

    // Without it there is no disclosure, and nothing is applied either.
    await refusal(
      run("applySourcePage", journalPage({ effectKey: "page-6" }), sessionFor(tenantId, userId, [])),
      "FORBIDDEN",
    );
    expect((await ledger("ledger_postings", tenantId)).map((row) => row.external_id)).toEqual(["e1"]);
    expect(await receipts(tenantId)).toHaveLength(1);
  }, TEST_TIMEOUT);

  test("leaves a page without a key exactly as it was: applied by source identity, no receipt", async () => {
    const tenantId = await tenant();
    const session = sessionFor(tenantId, randomUUID());
    const first = await run("applySourcePage", journalPage(), session);
    expect(first.batches[1].chunks[0]).toMatchObject({ created: 1 });
    const again = await run("applySourcePage", journalPage(), session);
    expect(again.batches[1].chunks[0]).toMatchObject({ created: 0, updated: 1 });
    expect((await ledger("ledger_postings", tenantId)).map((row) => row.external_id)).toEqual(["e1"]);
    expect(await receipts(tenantId)).toEqual([]);
  }, TEST_TIMEOUT);
});
