// SPDX-License-Identifier: BUSL-1.1
/**
 * A status transition end to end on REST: AgreementMilestone.trigger, the
 * one core state machine, offered on the record while it is pending, executed
 * under the record's version, refused afterwards, and never reachable through
 * the generic update. Runs against the shared e2e database like every other
 * suite here; the rows it creates are its own and are removed in afterAll.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/rest/__tests__/transitions.e2e.test.ts 2>&1
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
const writer: Identity = { tenantId: tenantA.tenantId, userId: randomUUID(), roles: ["Agreements.All.Read", "Agreements.All.ReadWrite"] };
const reader: Identity = { ...writer, userId: randomUUID(), roles: ["Agreements.All.Read"] };
const base = "/api/rest/v1/agreement-milestones";
const ids: string[] = [];
let app: Awaited<ReturnType<typeof apiApp>> | null = null;

beforeAll(async () => { app = await apiApp(); });
afterAll(async () => {
  if (ids.length) await sql`delete from erp.agreement_milestones where id in (${sql.join(ids)})`.execute(getSeedRuntime().db);
});

async function call(identity: Identity, method: "GET" | "POST" | "PATCH", url: string, payload?: unknown): Promise<{ status: number; body: any }> {
  const headers = new Headers();
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

async function milestone(): Promise<string> {
  const id = randomUUID();
  await sql`insert into erp.agreement_milestones (id, tenant_id, description, amount) values (${id}::uuid, ${writer.tenantId}::uuid, 'Go-live', 100)`
    .execute(getSeedRuntime().db);
  ids.push(id);
  return id;
}

const trigger = (offers: any[]) => offers.find((offer) => offer.operation.id === "AgreementMilestone.trigger");

describe("status transitions on REST", () => {
  test("the rule is offered while pending, runs under the record's version, and is refused afterwards", async () => {
    const id = await milestone();
    const pending = await call(writer, "GET", `${base}/${id}`);
    expect(pending.status).toBe(200);
    expect(pending.body.data.status).toBe("pending");
    expect(trigger(pending.body.operations)).toMatchObject({
      available: true, concurrency: { version: { mode: "required", field: "updatedAt" } }, binding: { input: { id } },
    });

    const unversioned = await call(writer, "POST", `${base}/${id}/trigger`, {});
    expect(unversioned.status).toBe(400);
    // Stamped fields are not input: the closed schema refuses them.
    const forged = await call(writer, "POST", `${base}/${id}/trigger`, { triggeredAt: "2000-01-01T00:00:00Z", expectedVersion: pending.body.data.updatedAt });
    expect(forged.status).toBe(400);

    const triggered = await call(writer, "POST", `${base}/${id}/trigger`, { expectedVersion: pending.body.data.updatedAt });
    expect(triggered.status).toBe(200);
    expect(triggered.body).toMatchObject({ id, status: "triggered", triggeredBy: writer.userId });
    expect(triggered.body.triggeredAt).toBe(triggered.body.updatedAt);
    expect(Date.parse(triggered.body.triggeredAt)).toBeGreaterThan(Date.now() - 60_000);

    const after = await call(writer, "GET", `${base}/${id}`);
    expect(after.body.data.status).toBe("triggered");
    expect(trigger(after.body.operations)).toMatchObject({ available: false, error: { code: "INVALID_STATE" } });

    const again = await call(writer, "POST", `${base}/${id}/trigger`, { expectedVersion: after.body.data.updatedAt });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: "INVALID_STATE", message: "AgreementMilestone is triggered; trigger moves status from pending to triggered." });
  });

  test("a reader is not offered the rule and may not run it; the generic update never writes the status", async () => {
    const id = await milestone();
    const seen = await call(reader, "GET", `${base}/${id}`);
    expect(seen.status).toBe(200);
    expect(trigger(seen.body.operations)).toBeUndefined();
    expect((await call(reader, "POST", `${base}/${id}/trigger`, { expectedVersion: seen.body.data.updatedAt })).status).toBe(403);

    const patched = await call(writer, "PATCH", `${base}/${id}`, { status: "triggered", expectedVersion: seen.body.data.updatedAt });
    expect(patched.status).toBe(400);
    expect(JSON.stringify(patched.body)).toContain("AgreementMilestone.trigger");
    expect((await call(writer, "GET", `${base}/${id}`)).body.data.status).toBe("pending");
  });
});
