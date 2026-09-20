// SPDX-License-Identifier: BUSL-1.1
/**
 * The milestone billing run against PostgreSQL, on a scratch database built
 * from the bundled manifest and driven through the restricted app role:
 * only triggered milestones of the caller's tenant are invoiced, each once,
 * the numbers come from InvoiceSequence even under concurrency, the core
 * receipt replays a key, and the milestones move through their transition.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { withDbSession } from "../../db/session.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { APP_ROLE, DEV_APP_ROLE_PASSWORD_DEFAULT } from "../../db/migrations/app-role.js";
import rawCatalog from "../../generated/operations/catalog.json" with { type: "json" };
import { executeKeyedOperation } from "../execution-receipts.js";
import type { OperationContract } from "../runtime.js";
import { createGeneratedEntityForTable } from "../entity/mutations.js";
import { executeTransition, transitionBinding, transitionOperationHandler } from "../entity/transitions.js";
import { billingTable, createAgreementMilestone } from "./agreement-milestone.js";
import { executeBillingRun, runMilestoneBilling, tenantCivilDate, type BillingRunInput, type BillingRunResult } from "./execute-billing-run.js";
import { issueNumberedInvoice } from "./invoice-numbering.js";
import { updateGeneratedEntity } from "../entity/mutations.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const scratchName = `billing_run_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const ROLES = ["Finance.All.Read", "Finance.All.ReadWrite", "Agreements.All.Read", "Agreements.All.ReadWrite"];

let admin: SQL, privileged: DatabaseRuntime, restricted: DatabaseRuntime;

function scratchUrl(role?: { username: string; password: string }): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev" || url.pathname === "/hubble_dev") throw new Error("admin URL must not point at an application database");
  if (role) { url.username = role.username; url.password = role.password; }
  url.pathname = `/${scratchName}`;
  return url.toString();
}

function sessionFor(tenantId: string, userId = randomUUID()): TrustedSessionContext {
  return { tenantId, userId, roles: ROLES, groups: [], scope: "tenant", credential: "bearer" } as unknown as TrustedSessionContext;
}

const catalogOperation = (key: string) => (rawCatalog as { operations: OperationContract[] }).operations.find((candidate) => candidate.key === key)!;
const trigger = transitionBinding(catalogOperation("AgreementMilestone.trigger"));
const handlerContext = (session: TrustedSessionContext) => ({ db: restricted.db, session, transport: "operation" as const }) as unknown as Parameters<typeof executeBillingRun>[1];

async function tenant(): Promise<string> {
  const id = randomUUID();
  await sql`insert into platform.tenants (id, slug, name, status) values (${id}::uuid, ${`billing-${id.slice(0, 8)}`}, 'Billing tenant', 'active')`.execute(privileged.db);
  return id;
}

async function agreement(tenantId: string): Promise<{ agreementId: string; relationId: string }> {
  const relationId = randomUUID(), agreementId = randomUUID();
  await sql`insert into erp.relations (id, tenant_id, display_name, relation_type) values (${relationId}::uuid, ${tenantId}::uuid, 'Customer', 'organization')`.execute(privileged.db);
  await sql`insert into erp.agreements (id, tenant_id, code, agreement_type, relation_id) values (${agreementId}::uuid, ${tenantId}::uuid, ${`AGR-${agreementId.slice(0, 8)}`}, 'service', ${relationId}::uuid)`.execute(privileged.db);
  return { agreementId, relationId };
}

async function milestone(session: TrustedSessionContext, agreementId: string, amount: number, state: "pending" | "triggered" | "cancelled" = "triggered"): Promise<string> {
  const created = await createAgreementMilestone({ agreementId, description: `Milestone ${amount}`, amount }, handlerContext(session));
  const id = String((created as { value: { id: string } }).value.id);
  if (state === "triggered") await executeTransition(restricted.db, session, trigger, { id });
  if (state === "cancelled") await executeTransition(restricted.db, session, transitionBinding(catalogOperation("AgreementMilestone.cancel")), { id });
  return id;
}

async function milestoneRow(id: string) {
  return (await sql<{ status: string; produced_invoice_id: string | null }>`select status, produced_invoice_id::text as produced_invoice_id from erp.agreement_milestones where id = ${id}::uuid`.execute(privileged.db)).rows[0]!;
}

/** The run the way the runtime invokes it: under the core receipt of the caller's key. */
function keyed(session: TrustedSessionContext, input: BillingRunInput, options: { at?: Date } = {}): Promise<BillingRunResult> {
  return executeKeyedOperation<BillingRunResult>(restricted.db, session, {
    operation: { id: "BillingRun.execute", intent: "invoke" },
    idempotencyKey: input.idempotencyKey,
    input: { ...input },
    idempotencyInputField: "idempotencyKey",
    contractFingerprint: `sha256:${createHash("sha256").update("billing-run-db-test").digest("hex")}`,
    externalWrite: false,
    execute: () => runMilestoneBilling(restricted.db, session, input, options),
    encode: (value) => value,
    decode: (value) => value as BillingRunResult,
  });
}

const fails = (promise: unknown, code: string) => expect(Promise.resolve(promise)).rejects.toMatchObject({ operationError: { code } });

describe("the milestone billing run against PostgreSQL", () => {
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

  test("invoices every triggered milestone of the tenant once, through the transition, and nothing else", async () => {
    const tenantA = await tenant(), tenantB = await tenant();
    const session = sessionFor(tenantA);
    const first = await agreement(tenantA), second = await agreement(tenantA), foreign = await agreement(tenantB);
    const triggered1 = await milestone(session, first.agreementId, 100);
    const triggered2 = await milestone(session, second.agreementId, 250.5);
    const triggered3 = await milestone(session, second.agreementId, 50);
    const pending = await milestone(session, first.agreementId, 40, "pending");
    const cancelled = await milestone(session, first.agreementId, 60, "cancelled");
    const other = await milestone(sessionFor(tenantB), foreign.agreementId, 999);

    const result = await executeBillingRun({ idempotencyKey: "run-1" }, handlerContext(session));
    const run = (result as { value: BillingRunResult }).value;
    // Two agreements, three milestones: the agreement counts count agreements.
    expect(run).toMatchObject({ status: "completed", mode: "milestone", dryRun: false, agreementsPlanned: 2, agreementsCompleted: 2, invoicesProduced: 3, totalAmount: "400.5" });
    expect(run.items.map((item) => [item.agreementMilestoneId, item.invoiceNumber, item.amount])).toEqual([[triggered1, 1, "100"], [triggered2, 2, "250.5"], [triggered3, 3, "50"]]);

    for (const [id, item] of [[triggered1, run.items[0]!], [triggered2, run.items[1]!], [triggered3, run.items[2]!]] as const) {
      expect(await milestoneRow(id)).toEqual({ status: "invoiced", produced_invoice_id: item.invoiceId });
      const invoice = (await sql<Record<string, unknown>>`select to_jsonb(i.*) as row from erp.invoices i where id = ${item.invoiceId}::uuid`.execute(privileged.db)).rows[0]!.row as Record<string, unknown>;
      expect(invoice).toMatchObject({ tenant_id: tenantA, invoice_kind: "sales", invoice_status: "issued", invoice_number: item.invoiceNumber, agreement_id: item.agreementId });
      expect(Number(invoice.amount_total)).toBe(Number(item.amount));
      expect(invoice.relation_id).toBe(item.agreementId === first.agreementId ? first.relationId : second.relationId);
      const lines = (await sql<{ amount_total: string }>`select amount_total from erp.invoice_lines where invoice_id = ${item.invoiceId}::uuid`.execute(privileged.db)).rows;
      expect(lines.map((line) => Number(line.amount_total))).toEqual([Number(item.amount)]);
    }
    expect((await milestoneRow(pending)).status).toBe("pending");
    expect((await milestoneRow(cancelled)).status).toBe("cancelled");
    expect(await milestoneRow(other)).toEqual({ status: "triggered", produced_invoice_id: null });

    const items = (await sql<{ status: string; agreement_milestone_id: string }>`select status, agreement_milestone_id::text as agreement_milestone_id from erp.billing_run_items where billing_run_id = ${run.id}::uuid order by created_at`.execute(privileged.db)).rows;
    expect(items.map((item) => item.agreement_milestone_id)).toEqual([triggered1, triggered2, triggered3]);
    expect(items.every((item) => item.status === "completed")).toBe(true);
    const stored = (await sql<{ status: string; mode: string; agreements_planned: number; agreements_completed: number; invoices_produced: number; total_amount: string; triggered_by: string }>`select status, mode, agreements_planned, agreements_completed, invoices_produced, total_amount, triggered_by from erp.billing_runs where id = ${run.id}::uuid`.execute(privileged.db)).rows[0]!;
    expect(stored).toMatchObject({ status: "completed", mode: "milestone", agreements_planned: 2, agreements_completed: 2, invoices_produced: 3, triggered_by: session.userId });
    expect(Number(stored.total_amount)).toBe(400.5);
    // The transition journaled the milestone update like any other write.
    const events = (await sql<{ event_type: string }>`select event_type from platform.entity_events where aggregate_id = ${triggered1} order by sequence`.execute(privileged.db)).rows.map((event) => event.event_type);
    expect(events).toEqual(["created", "updated", "updated"]);

    // A second run finds nothing left: invoiced is terminal.
    const again = (await executeBillingRun({ idempotencyKey: "run-2" }, handlerContext(session)) as { value: BillingRunResult }).value;
    expect(again).toMatchObject({ agreementsPlanned: 0, invoicesProduced: 0, totalAmount: "0", items: [] });
  }, 60_000);

  test("a replay with the same key returns the first result through the core receipt; another actor's reuse is refused", async () => {
    const tenantId = await tenant();
    const session = sessionFor(tenantId);
    const { agreementId } = await agreement(tenantId);
    const id = await milestone(session, agreementId, 75);
    const first = await keyed(session, { idempotencyKey: "replay" });
    expect(first.items).toHaveLength(1);
    await milestone(session, agreementId, 25);
    const replay = await keyed(session, { idempotencyKey: "replay" });
    expect(replay).toEqual(first);
    const runs = (await sql<{ count: string }>`select count(*)::text as count from erp.billing_runs where tenant_id = ${tenantId}::uuid`.execute(privileged.db)).rows[0]!.count;
    expect(runs).toBe("1");
    expect((await milestoneRow(id)).status).toBe("invoiced");
    await fails(keyed(sessionFor(tenantId), { idempotencyKey: "replay" }), "ALREADY_EXISTS");
  }, 60_000);

  test("two concurrent runs on the first number of a fiscal year receive distinct numbers", async () => {
    const tenantId = await tenant();
    const session = sessionFor(tenantId);
    const left = await agreement(tenantId), right = await agreement(tenantId);
    await milestone(session, left.agreementId, 10);
    await milestone(session, right.agreementId, 20);
    const [one, two] = await Promise.all([
      keyed(session, { idempotencyKey: "left", agreementId: left.agreementId }),
      keyed(session, { idempotencyKey: "right", agreementId: right.agreementId }),
    ]);
    const numbers = [...one.items, ...two.items].map((item) => item.invoiceNumber).sort();
    expect(numbers).toEqual([1, 2]);
    const sequence = (await sql<{ last_number: number; count: string }>`select last_number, count(*) over ()::text as count from erp.invoice_sequences where tenant_id = ${tenantId}::uuid and kind = 'sales'`.execute(privileged.db)).rows;
    expect(sequence).toEqual([{ last_number: 2, count: "1" }]);
  }, 60_000);

  test("a dry run plans and counts but invoices nothing; an unknown agreement filter is refused", async () => {
    const tenantId = await tenant();
    const session = sessionFor(tenantId);
    const { agreementId } = await agreement(tenantId);
    const id = await milestone(session, agreementId, 30);
    const dry = await keyed(session, { idempotencyKey: "dry", dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, agreementsPlanned: 1, agreementsCompleted: 0, invoicesProduced: 0, totalAmount: "30", items: [{ agreementMilestoneId: id, invoiceId: null, invoiceNumber: null, amount: "30" }] });
    expect((await milestoneRow(id)).status).toBe("triggered");
    expect((await sql<{ count: string }>`select count(*)::text as count from erp.invoices where tenant_id = ${tenantId}::uuid`.execute(privileged.db)).rows[0]!.count).toBe("0");
    await fails(keyed(session, { idempotencyKey: "missing", agreementId: randomUUID() }), "REFERENCE_NOT_FOUND");
    expect((await sql<{ count: string }>`select count(*)::text as count from erp.billing_runs where tenant_id = ${tenantId}::uuid`.execute(privileged.db)).rows[0]!.count).toBe("1");
  }, 60_000);

  test("the invoice transition itself runs only from triggered and requires an invoice of the milestone's agreement", async () => {
    const tenantId = await tenant();
    const session = sessionFor(tenantId);
    const { agreementId } = await agreement(tenantId);
    const elsewhere = await agreement(tenantId);
    const pending = await milestone(session, agreementId, 5, "pending");
    const invoice = transitionOperationHandler(catalogOperation("AgreementMilestone.invoice"));
    const context = handlerContext(session) as unknown as Parameters<typeof invoice>[1];
    const draft = (extra: Record<string, unknown>) => createGeneratedEntityForTable(restricted.db, session, billingTable("Invoice"), { invoiceKind: "sales", invoiceStatus: "draft", issueDate: "2026-01-01", currencyCode: "EUR", ...extra });
    const own = await draft({ agreementId });
    await fails(invoice({ id: pending, producedInvoiceId: String(own.id) }, context), "INVALID_STATE");

    const triggered = await milestone(session, agreementId, 5);
    // No invoice, an unknown invoice, an invoice of another agreement, an invoice without one: all refused, the milestone stays triggered.
    await expect(Promise.resolve(invoice({ id: triggered }, context))).rejects.toMatchObject({ operationError: { code: "VALIDATION", violations: [{ field: "producedInvoiceId" }] } });
    await fails(invoice({ id: triggered, producedInvoiceId: randomUUID() }, context), "VALIDATION");
    const foreign = await draft({ agreementId: elsewhere.agreementId });
    await expect(Promise.resolve(invoice({ id: triggered, producedInvoiceId: String(foreign.id) }, context))).rejects.toMatchObject({
      operationError: { code: "VALIDATION", message: "producedInvoiceId must name Invoice that agrees with this AgreementMilestone on agreementId." },
    });
    const orphan = await draft({});
    await fails(invoice({ id: triggered, producedInvoiceId: String(orphan.id) }, context), "VALIDATION");
    expect(await milestoneRow(triggered)).toEqual({ status: "triggered", produced_invoice_id: null });

    const result = await invoice({ id: triggered, producedInvoiceId: String(own.id) }, context);
    expect(result).toMatchObject({ value: { status: "invoiced", producedInvoiceId: own.id } });
    await fails(invoice({ id: triggered, producedInvoiceId: String(own.id) }, context), "INVALID_STATE");

    // The comparison is the database's: a null agrees with a null and with nothing else.
    const unattached = String((await createGeneratedEntityForTable(restricted.db, session, billingTable("AgreementMilestone"), { description: "Loose", amount: 1 })).id);
    // No agreement: trigger's referenced precondition refuses. The invoice
    // agreesOn case still needs a triggered row whose agreementId is null.
    await sql`update erp.agreement_milestones set status = 'triggered' where id = ${unattached}::uuid`.execute(privileged.db);
    await fails(invoice({ id: unattached, producedInvoiceId: String(own.id) }, context), "VALIDATION");
    expect(await invoice({ id: unattached, producedInvoiceId: String(orphan.id) }, context)).toMatchObject({ value: { status: "invoiced" } });
  }, 60_000);

  test("numbers are issued past any invoice that already holds the next number", async () => {
    const tenantId = await tenant();
    const session = sessionFor(tenantId);
    const { agreementId } = await agreement(tenantId);
    await milestone(session, agreementId, 10);
    await milestone(session, agreementId, 20);
    // Planted behind the run's back, with the number the counter would issue first.
    await sql`insert into erp.invoices (tenant_id, invoice_kind, invoice_status, invoice_number, fiscal_year_code, issue_date, currency_code)
      values (${tenantId}::uuid, 'sales', 'issued', 1, ${new Date().toISOString().slice(0, 4)}, current_date, 'EUR')`.execute(privileged.db);
    const run = await keyed(session, { idempotencyKey: "past-taken" });
    expect(run.items.map((item) => item.invoiceNumber)).toEqual([2, 3]);
    const numbers = (await sql<{ invoice_number: number }>`select invoice_number from erp.invoices where tenant_id = ${tenantId}::uuid order by invoice_number`.execute(privileged.db)).rows.map((row) => row.invoice_number);
    expect(numbers).toEqual([1, 2, 3]);
    const sequence = (await sql<{ last_number: number }>`select last_number from erp.invoice_sequences where tenant_id = ${tenantId}::uuid`.execute(privileged.db)).rows;
    expect(sequence).toEqual([{ last_number: 3 }]);
  }, 60_000);

  test("a number taken between its allocation and the insert is skipped under a savepoint, in the same transaction", async () => {
    const tenantId = await tenant();
    const session = sessionFor(tenantId);
    const fiscalYearCode = "2031";
    const plant = (number: number) => sql`insert into erp.invoices (tenant_id, invoice_kind, invoice_status, invoice_number, fiscal_year_code, issue_date, currency_code)
      values (${tenantId}::uuid, 'sales', 'issued', ${number}, ${fiscalYearCode}, current_date, 'EUR')`.execute(privileged.db);
    const attempts: number[] = [];
    const issued = await withDbSession(restricted.db, session, (trx) =>
      issueNumberedInvoice(trx, { tenantId, kind: "sales", fiscalYearCode }, async (number) => {
        attempts.push(number);
        // Another writer commits the very number this attempt was handed, after the allocation and before the insert.
        if (attempts.length === 1) await plant(number);
        return createGeneratedEntityForTable(restricted.db, session, billingTable("Invoice"), {
          invoiceKind: "sales", invoiceStatus: "issued", invoiceNumber: number, fiscalYearCode, issueDate: "2031-01-01", currencyCode: "EUR",
        });
      }));
    expect(attempts).toEqual([1, 2]);
    expect(issued.invoiceNumber).toBe(2);
    const numbers = (await sql<{ invoice_number: number }>`select invoice_number from erp.invoices where tenant_id = ${tenantId}::uuid order by invoice_number`.execute(privileged.db)).rows.map((row) => row.invoice_number);
    expect(numbers).toEqual([1, 2]);
    // A failure that is not the number being taken is the caller's, rethrown after the rollback.
    await expect(withDbSession(restricted.db, session, (trx) =>
      issueNumberedInvoice(trx, { tenantId, kind: "sales", fiscalYearCode }, async () => { throw new Error("not a number problem"); }))).rejects.toThrow("not a number problem");
  }, 60_000);

  test("the issue date and fiscal year come from the tenant's own clock, not UTC", async () => {
    const tenantId = await tenant();
    const session = sessionFor(tenantId);
    // Half past midnight on 1 January in Amsterdam is still 31 December in UTC.
    const boundary = new Date("2030-12-31T23:30:00Z");
    expect(await withDbSession(restricted.db, session, (trx) => tenantCivilDate(trx, tenantId, boundary))).toBe("2031-01-01");
    await sql`update platform.tenants set time_zone = 'UTC' where id = ${tenantId}::uuid`.execute(privileged.db);
    expect(await withDbSession(restricted.db, session, (trx) => tenantCivilDate(trx, tenantId, boundary))).toBe("2030-12-31");
    await sql`update platform.tenants set time_zone = 'Pacific/Kiritimati' where id = ${tenantId}::uuid`.execute(privileged.db);
    const { agreementId } = await agreement(tenantId);
    await milestone(session, agreementId, 12);
    const run = await keyed(session, { idempotencyKey: "boundary" }, { at: boundary });
    const invoice = (await sql<{ fiscal_year_code: string; issue_date: string }>`select fiscal_year_code, issue_date::text as issue_date from erp.invoices where id = ${run.items[0]!.invoiceId}::uuid`.execute(privileged.db)).rows[0]!;
    expect(invoice).toEqual({ fiscal_year_code: "2031", issue_date: "2031-01-01" });
    expect((await sql<{ fiscal_year_code: string }>`select fiscal_year_code from erp.invoice_sequences where tenant_id = ${tenantId}::uuid`.execute(privileged.db)).rows).toEqual([{ fiscal_year_code: "2031" }]);
  }, 60_000);

  test("a milestone belongs to one agreement for life", async () => {
    const tenantId = await tenant();
    const session = sessionFor(tenantId);
    const { agreementId } = await agreement(tenantId);
    const other = await agreement(tenantId);
    const id = await milestone(session, agreementId, 9, "pending");
    // The column is immutable: the write policy never lets an update carry it (the caller-facing
    // transports refuse it by name — see the REST suite), so the agreement stays what it was.
    const table = billingTable("AgreementMilestone");
    expect(table.columns.find((column) => column.name === "agreement_id")).toMatchObject({ immutable: true });
    await updateGeneratedEntity(restricted.db, session, { table: table.name, id, values: { agreementId: other.agreementId, description: "Moved?" } });
    expect((await sql<{ agreement_id: string; description: string }>`select agreement_id::text as agreement_id, description from erp.agreement_milestones where id = ${id}::uuid`.execute(privileged.db)).rows[0])
      .toEqual({ agreement_id: agreementId, description: "Moved?" });
  }, 60_000);
});
