// SPDX-License-Identifier: BUSL-1.1
/**
 * The milestone billing run end to end on REST: BillingRun.execute under
 * the Idempotency-Key header, AgreementMilestone.create as the projected
 * plugin create, and the milestone's `invoice` transition as the only way
 * a milestone becomes invoiced. Runs against the shared e2e database like
 * every other suite here; the rows it creates are its own and are removed
 * in afterAll.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/rest/__tests__/billing-run.e2e.test.ts 2>&1
 */
import { afterAll, beforeAll, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import {
  apiApp, describe, getSeedRuntime, registerSuiteLifecycle, remoteUrl, tenantA, test, type Identity,
} from "../../graphql/__tests__/e2e/harness.js";

registerSuiteLifecycle();

const SECRET = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET ?? null;
const finance: Identity = {
  tenantId: tenantA.tenantId, userId: randomUUID(),
  roles: ["Agreements.All.Read", "Agreements.All.ReadWrite", "Finance.All.Read", "Finance.All.ReadWrite"],
};
const contracts: Identity = { ...finance, userId: randomUUID(), roles: ["Agreements.All.Read", "Agreements.All.ReadWrite"] };
const milestones = "/api/rest/v1/agreement-milestones";
const runs = "/api/rest/v1/billing-runs";
const agreementId = randomUUID();
const runKey = `e2e-${randomUUID()}`;
let app: Awaited<ReturnType<typeof apiApp>> | null = null;

beforeAll(async () => {
  app = await apiApp();
  await sql`insert into erp.agreements (id, tenant_id, code, agreement_type) values (${agreementId}::uuid, ${finance.tenantId}::uuid, ${`E2E-${agreementId.slice(0, 8)}`}, 'service')`
    .execute(getSeedRuntime().db);
});
afterAll(async () => {
  const db = getSeedRuntime().db;
  await sql`delete from erp.billing_run_items where agreement_id = ${agreementId}::uuid`.execute(db);
  await sql`delete from erp.billing_runs where tenant_id = ${finance.tenantId}::uuid and triggered_by = ${finance.userId}`.execute(db);
  await sql`delete from erp.agreement_milestones where agreement_id = ${agreementId}::uuid`.execute(db);
  await sql`delete from erp.invoice_lines where invoice_id in (select id from erp.invoices where agreement_id = ${agreementId}::uuid)`.execute(db);
  await sql`delete from erp.invoices where agreement_id = ${agreementId}::uuid`.execute(db);
  await sql`delete from erp.agreements where id = ${agreementId}::uuid`.execute(db);
  await sql`delete from platform.operation_execution_receipts where tenant_id = ${finance.tenantId}::uuid and actor_id = ${finance.userId}::uuid`.execute(db);
  await sql`delete from erp.invoice_sequences where tenant_id = ${finance.tenantId}::uuid`.execute(db);
});

async function call(
  identity: Identity, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown, extra: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const headers = new Headers(extra);
  applyTrustedContextHeaders(headers, identity, { secret: SECRET });
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  if (body !== undefined) headers.set("content-type", "application/json");
  if (remoteUrl) {
    const response = await fetch(`${remoteUrl}${url}`, { method, headers, ...(body === undefined ? {} : { body }) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  }
  const response = await app!.inject({ method, url, headers: Object.fromEntries(headers.entries()), ...(body === undefined ? {} : { payload: body }) });
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined };
}

const execute = (identity: Identity, key: string, payload: Record<string, unknown> = {}) =>
  call(identity, "POST", `${runs}/execute`, payload, { "idempotency-key": key });

describe("the milestone billing run on REST", () => {
  test("the projected create computes a percentage into a frozen amount and refuses an amountless milestone", async () => {
    const percent = await call(contracts, "POST", milestones, { agreementId, description: "Kickoff", basisAmount: 10000, percentOfBasis: 25 });
    expect(percent.status).toBe(201);
    expect(percent.body.data).toMatchObject({ agreementId, status: "pending", basisAmount: 10000, percentOfBasis: 25, amount: 2500 });
    const invalid = await call(contracts, "POST", milestones, { agreementId, description: "Nothing" });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error).toMatchObject({ code: "VALIDATION", violations: expect.arrayContaining([expect.objectContaining({ field: "amount" })]) });
    // The status is not part of the create's closed input: it is written by the transitions only.
    const forged = await call(contracts, "POST", milestones, { agreementId, description: "Forged", amount: 1, status: "triggered" });
    expect(forged.status).toBe(422);
    expect(forged.body.error.code).toBe("VALIDATION");
  });

  test("the run invoices the triggered milestones only, replays under its key, and is finance-only", async () => {
    const create = async (description: string, amount: number) => {
      const created = await call(contracts, "POST", milestones, { agreementId, description, amount });
      expect(created.status).toBe(201);
      return created.body.data as { id: string; updatedAt: string };
    };
    const triggered = await create("Go-live", 1200);
    const pending = await create("Acceptance", 800);
    expect((await call(contracts, "POST", `${milestones}/${triggered.id}/trigger`, { expectedVersion: triggered.updatedAt })).status).toBe(200);

    expect((await execute(contracts, `${runKey}-contracts`)).status).toBe(403);
    const keyless = await call(finance, "POST", `${runs}/execute`, {});
    expect(keyless.status).toBe(400);

    const first = await execute(finance, runKey, { agreementId });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: "completed", mode: "milestone", agreementsPlanned: 1, invoicesProduced: 1, totalAmount: 1200 });
    expect(first.body.items).toEqual([expect.objectContaining({ agreementMilestoneId: triggered.id, agreementId, amount: 1200 })]);
    const item = first.body.items[0];
    expect(typeof item.invoiceId).toBe("string");
    expect(item.invoiceNumber).toBeGreaterThan(0);

    const invoiced = await call(finance, "GET", `${milestones}/${triggered.id}`);
    expect(invoiced.body.data).toMatchObject({ status: "invoiced", producedInvoiceId: item.invoiceId });
    expect(invoiced.body.operations.find((offer: any) => offer.operation.id === "AgreementMilestone.invoice")).toMatchObject({ available: false, error: { code: "INVALID_STATE" } });
    expect((await call(finance, "GET", `${milestones}/${pending.id}`)).body.data.status).toBe("pending");
    const invoice = await call(finance, "GET", `/api/rest/v1/invoices/${item.invoiceId}`);
    expect(invoice.status).toBe(200);
    expect(invoice.body.data).toMatchObject({ invoiceKind: "sales", invoiceStatus: "issued", invoiceNumber: item.invoiceNumber, amountTotal: 1200, agreementId });
    const run = await call(finance, "GET", `${runs}/${first.body.id}`);
    expect(run.body.data).toMatchObject({ status: "completed", mode: "milestone", invoicesProduced: 1, idempotencyKey: runKey });

    const replay = await execute(finance, runKey, { agreementId });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    const reused = await execute(finance, runKey, { agreementId, dryRun: true });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    // The number and its year are the run's: no generic create or update sets them,
    // and the counter behind them has no write on any interface.
    const numbered = await call(finance, "POST", "/api/rest/v1/invoices", { invoiceKind: "sales", invoiceStatus: "draft", issueDate: "2026-01-01", currencyCode: "EUR", invoiceNumber: 999 });
    expect(numbered.status).toBe(400);
    expect(JSON.stringify(numbered.body)).toContain("BillingRun.execute");
    const renumbered = await call(finance, "PATCH", `/api/rest/v1/invoices/${item.invoiceId}`, { invoiceNumber: 999, expectedVersion: invoice.body.data.updatedAt });
    expect(renumbered.status).toBe(400);
    expect(JSON.stringify(renumbered.body)).toContain("BillingRun.execute");
    const counter = (await sql<{ id: string; updated_at: string }>`select id::text as id, updated_at::text as updated_at from erp.invoice_sequences where tenant_id = ${finance.tenantId}::uuid and kind = 'sales' order by fiscal_year_code desc limit 1`.execute(getSeedRuntime().db)).rows[0]!;
    expect(counter).toBeDefined();
    expect((await call(finance, "GET", `/api/rest/v1/invoice-sequences/${counter.id}`)).status).toBe(200);
    expect((await call(finance, "PATCH", `/api/rest/v1/invoice-sequences/${counter.id}`, { lastNumber: 0, expectedVersion: counter.updated_at })).status).toBe(404);
    expect((await call(finance, "POST", "/api/rest/v1/invoice-sequences", { kind: "sales", fiscalYearCode: "1999", lastNumber: 0 })).status).toBe(404);
    expect((await call(finance, "DELETE", `/api/rest/v1/invoice-sequences/${counter.id}`)).status).toBe(404);

    // Nothing is left to invoice, and the status never yields to a generic update.
    const again = await execute(finance, `${runKey}-again`, { agreementId });
    expect(again.body).toMatchObject({ agreementsPlanned: 0, invoicesProduced: 0, items: [] });
    const patched = await call(finance, "PATCH", `${milestones}/${pending.id}`, { status: "invoiced", expectedVersion: pending.updatedAt });
    expect(patched.status).toBe(400);
    expect(JSON.stringify(patched.body)).toContain("AgreementMilestone.invoice");
  });
});
