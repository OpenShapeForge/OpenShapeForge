// SPDX-License-Identifier: BUSL-1.1
/**
 * A capability Operation end to end over REST: a plugin issues a grant from
 * an ordinary session Operation through `platform.grants.issue`, the
 * recipient presents `Authorization: Grant <token>` to an
 * `auth.mode: capability` Operation, and core refuses everything the grant
 * does not cover. The operator Operations `grants.list` and `grants.revoke`
 * are driven from the generated catalog on the same app.
 *
 * Self-contained on a migrated scratch database, so it holds whatever the
 * shared development database currently looks like.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import Fastify, { type FastifyInstance } from "fastify";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { createDatabaseRuntime } from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { withDbSession } from "../../db/session.js";
import { __resetSessionResolverForTests } from "../../auth/identity.js";
import type { RuntimeModule } from "../../modules/contract.js";
import { ModulePlatformRuntime } from "../../modules/platform.js";
import { HttpError } from "../http-error.js";
import { CAPABILITY_GRANT_ATTEMPT_POLICY } from "../../operations/capability-grant-resolution.js";
import {
  listOperationContracts,
  registerOperationRestRoutes,
  type OperationContract,
} from "../../operations/runtime.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const SECRET = "capability-grants-e2e-context-secret";
const TEST_TIMEOUT = 120_000;

const GRANT_ERRORS: OperationContract["errors"] = [
  { status: 401, code: "GRANT_INVALID", description: "Invalid." },
  { status: 403, code: "GRANT_SCOPE", description: "Scope." },
  { status: 409, code: "GRANT_CONSUMED", description: "Consumed." },
  { status: 410, code: "GRANT_EXPIRED", description: "Expired." },
  { status: 410, code: "GRANT_REVOKED", description: "Revoked." },
  { status: 423, code: "GRANT_LOCKED", description: "Locked." },
];

const disabled = { enabled: false as const, reason: "A grant token is presented on REST only." };

function capabilityOperation(key: string, handler: string, path: string): OperationContract {
  return {
    key,
    plugin: "envelopes",
    title: key,
    description: key,
    handler,
    inputSchema: { type: "object", additionalProperties: false, properties: { note: { type: "string" } } },
    outputSchema: {
      type: "object",
      required: ["subject", "recipient", "credential", "roles"],
      properties: {
        subject: { type: "object", additionalProperties: true },
        recipient: { type: "object", additionalProperties: true },
        credential: { type: "string" },
        roles: { type: "array", items: { type: "string" } },
        uses: { type: "integer" },
      },
      additionalProperties: false,
    },
    errors: GRANT_ERRORS,
    auth: { mode: "capability" },
    tenancy: { mode: "required" },
    idempotency: { mode: "intrinsic" },
    effects: { data: "write", external: "none" },
    transports: {
      rest: { method: "POST", path, response: { status: 200, kind: "json" } },
      mcp: disabled,
      graphql: disabled,
      typescript: { enabled: true, functionName: handler },
    },
  };
}

const readOperation = capabilityOperation("envelopes.envelope.read", "readEnvelope", "/api/envelopes/link/read");
const signOperation = capabilityOperation("envelopes.envelope.sign", "signEnvelope", "/api/envelopes/link/sign");
const declineOperation = capabilityOperation("envelopes.envelope.decline", "declineEnvelope", "/api/envelopes/link/decline");

const issueOperation: OperationContract = {
  key: "envelopes.link.issue",
  plugin: "envelopes",
  title: "Issue link",
  description: "Issues a signing link.",
  handler: "issueLink",
  inputSchema: {
    type: "object",
    required: ["envelopeId", "address"],
    properties: {
      envelopeId: { type: "string" },
      address: { type: "string" },
      operations: { type: "array", items: { type: "string" } },
      maxUses: { type: ["integer", "null"] },
      expiresInSeconds: { type: "integer" },
      supersede: { type: "boolean" },
      fail: { type: "boolean" },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    required: ["id", "token"],
    properties: { id: { type: "string" }, token: { type: "string" } },
    additionalProperties: false,
  },
  errors: [{ status: 409, code: "CONFLICT", description: "Handler failed after issuing." }],
  auth: { mode: "session", roles: ["Organization.All.ReadWrite"] },
  tenancy: { mode: "required" },
  idempotency: { mode: "intrinsic" },
  effects: { data: "write", external: "none" },
  transports: {
    rest: { method: "POST", path: "/api/envelopes/links", response: { status: 201, kind: "json" } },
    mcp: disabled,
    graphql: disabled,
    typescript: { enabled: true, functionName: "issueLink" },
  },
};

const envelopesModule: RuntimeModule = {
  name: "envelopes",
  operationHandlers: {
    async issueLink(input, context) {
      // The grant is issued inside the plugin's own transaction, next to
      // whatever else the plugin writes about the envelope.
      return context.platform!.db.withSession(context.session!, async () => {
        const issued = await context.platform!.grants.issue(context.session!, {
          operations: (input.operations as string[] | undefined) ?? [readOperation.key, signOperation.key],
          subject: { entity: "Envelope", id: input.envelopeId as string },
          recipient: { kind: "email", address: input.address as string },
          expiresAt: new Date(Date.now() + ((input.expiresInSeconds as number | undefined) ?? 3600) * 1000),
          maxUses: (input.maxUses as number | null | undefined) ?? null,
          ...(input.supersede ? { supersede: "same-subject-and-recipient" as const } : {}),
        });
        if (input.fail) throw new HttpError(409, "CONFLICT", "Rolled back after issuing.");
        return { status: 201, value: { id: issued.id, token: issued.token } };
      });
    },
    async readEnvelope(_input, context) {
      const session = context.session!;
      return { value: { subject: session.grant!.subject, recipient: session.grant!.recipient, credential: session.credential, roles: session.roles } };
    },
    async signEnvelope(input, context) {
      const session = context.session!;
      if (input.note === "fail") throw new Error("Signing failed after the grant was counted.");
      // A handler works under the grant session: RLS is on, the tenant is the
      // grant's, and platform services accept the session like any other.
      await context.platform!.events.append(session, {
        aggregateType: "envelope",
        aggregateId: session.grant!.subject.id,
        eventType: "envelope_signed",
        payload: { grantId: session.grant!.id },
      });
      return { value: { subject: session.grant!.subject, recipient: session.grant!.recipient, credential: session.credential, roles: session.roles } };
    },
    async declineEnvelope(_input, context) {
      const session = context.session!;
      return { value: { subject: session.grant!.subject, recipient: session.grant!.recipient, credential: session.credential, roles: session.roles } };
    },
  },
};

const scratch = `capability_grants_e2e_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
let admin: SQL;
let runtime: ReturnType<typeof createDatabaseRuntime>;
let app: FastifyInstance;
let tenantId = "";
let tenantB = "";
const previousEnv = {
  secret: process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET,
  jwks: process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI,
  issuer: process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER,
};

function scratchUrl(appRole: boolean): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") throw new Error("admin URL must not point at openshapeforge_dev");
  if (appRole) {
    url.username = "openshapeforge_app";
    url.password = "openshapeforge_app";
  }
  url.pathname = `/${scratch}`;
  return url.toString();
}

function operatorHeaders(tenant: string, roles = ["Organization.All.ReadWrite"]): Record<string, string> {
  const headers = new Headers({ "content-type": "application/json" });
  applyTrustedContextHeaders(headers, { tenantId: tenant, userId: randomUUID(), roles, groups: [] }, { secret: SECRET });
  return Object.fromEntries(headers.entries());
}

async function issue(body: Record<string, unknown>, tenant = tenantId) {
  const response = await app.inject({ method: "POST", url: "/api/envelopes/links", headers: operatorHeaders(tenant), payload: body });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; token: string };
}

async function present(path: string, token: string | undefined, payload: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: "POST",
    url: path,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Grant ${token}` } : {}) },
    payload,
  });
  return { status: response.statusCode, body: response.json() as { error?: { code: string } } & Record<string, unknown> };
}

beforeAll(async () => {
  process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = SECRET;
  delete process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI;
  delete process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER;
  __resetSessionResolverForTests();
  admin = new SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`create database "${scratch}"`);
  const migrator = createDatabaseRuntime({ databaseUrl: scratchUrl(false), maxConnections: 2 });
  try {
    await migrator.db.connection().execute((conn) => runMigrationChain(conn));
    for (const [slug, assign] of [["grants-e2e-a", (id: string) => { tenantId = id; }], ["grants-e2e-b", (id: string) => { tenantB = id; }]] as const) {
      const inserted = await sql<{ id: string }>`
        insert into platform.tenants (slug, name, status) values (${slug}, ${slug}, 'active') returning id::text
      `.execute(migrator.db);
      assign(inserted.rows[0]!.id);
    }
  } finally {
    await migrator.close();
  }
  runtime = createDatabaseRuntime({ databaseUrl: scratchUrl(true), maxConnections: 4 });
  const operatorOperations = listOperationContracts().filter((operation) => operation.plugin === "osf-grants");
  expect(operatorOperations.map((operation) => operation.key).sort()).toEqual(["grants.list", "grants.revoke"]);
  const operations = [issueOperation, readOperation, signOperation, declineOperation, ...operatorOperations];
  const platform = new ModulePlatformRuntime(runtime.db, {
    capabilityOperations: new Set([readOperation.key, signOperation.key, declineOperation.key]),
  });
  app = Fastify();
  registerOperationRestRoutes(app, [envelopesModule], { db: runtime.db, platform: platform.services }, operations);
  await app.ready();
}, TEST_TIMEOUT);

afterAll(async () => {
  await app?.close();
  await runtime?.close();
  await admin?.unsafe(`drop database if exists "${scratch}" with (force)`);
  await admin?.close();
  process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = previousEnv.secret;
  if (previousEnv.jwks) process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI = previousEnv.jwks;
  if (previousEnv.issuer) process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = previousEnv.issuer;
  __resetSessionResolverForTests();
});

describe("capability grants over REST", () => {
  test("a valid grant runs the covered Operations under a grant session and nothing else", async () => {
    const envelopeId = randomUUID();
    const link = await issue({ envelopeId, address: "customer@example.test" });

    const read = await present(readOperation.transports.rest.path, link.token);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      subject: { entity: "Envelope", id: envelopeId },
      recipient: { kind: "email", address: "customer@example.test" },
      credential: "grant",
      roles: [],
    });

    // Not in the grant's list, however valid the token.
    const decline = await present(declineOperation.transports.rest.path, link.token);
    expect(decline).toMatchObject({ status: 403, body: { error: { code: "GRANT_SCOPE" } } });

    // A grant is not a session: the issuing Operation refuses it.
    const escalate = await app.inject({
      method: "POST",
      url: "/api/envelopes/links",
      headers: { "content-type": "application/json", authorization: `Grant ${link.token}` },
      payload: { envelopeId, address: "x@example.test" },
    });
    expect(escalate.statusCode).toBe(401);

    // And a session is not a grant: a bearer-less operator call is refused as invalid.
    const withSession = await app.inject({
      method: "POST",
      url: readOperation.transports.rest.path,
      headers: operatorHeaders(tenantId),
      payload: {},
    });
    expect(withSession.statusCode).toBe(401);
    expect((withSession.json() as { error: { code: string } }).error.code).toBe("GRANT_INVALID");

    // Missing and malformed tokens.
    expect(await present(readOperation.transports.rest.path, undefined)).toMatchObject({ status: 401, body: { error: { code: "GRANT_INVALID" } } });
    expect(await present(readOperation.transports.rest.path, "nonsense")).toMatchObject({ status: 401, body: { error: { code: "GRANT_INVALID" } } });
  }, TEST_TIMEOUT);

  test("a wrong secret counts, the limit locks, and the operator sees and revokes the grant", async () => {
    const envelopeId = randomUUID();
    const link = await issue({ envelopeId, address: "locked@example.test" });
    const [id, secret] = link.token.split(".") as [string, string];
    const wrong = `${id}.${secret.replace(/^./, (c) => (c === "A" ? "B" : "A"))}`;
    for (let attempt = 1; attempt < CAPABILITY_GRANT_ATTEMPT_POLICY.maxFailedAttempts; attempt += 1) {
      expect(await present(readOperation.transports.rest.path, wrong)).toMatchObject({ status: 401, body: { error: { code: "GRANT_INVALID" } } });
    }
    expect(await present(readOperation.transports.rest.path, wrong)).toMatchObject({ status: 423, body: { error: { code: "GRANT_LOCKED" } } });
    expect(await present(readOperation.transports.rest.path, link.token)).toMatchObject({ status: 423, body: { error: { code: "GRANT_LOCKED" } } });

    const listed = await app.inject({
      method: "GET",
      url: `/api/grants?subjectEntity=Envelope&subjectId=${envelopeId}`,
      headers: operatorHeaders(tenantId),
    });
    expect(listed.statusCode).toBe(200);
    const { grants } = listed.json() as { grants: Record<string, unknown>[] };
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ id, status: "active", uses: 0, recipient: { kind: "email", address: "locked@example.test" } });
    expect(typeof grants[0]!.lockedUntil).toBe("string");
    expect(JSON.stringify(grants[0])).not.toContain(secret);

    // Another tenant sees nothing and cannot revoke it; the wrong role cannot list.
    const stranger = await app.inject({ method: "GET", url: `/api/grants?subjectEntity=Envelope&subjectId=${envelopeId}`, headers: operatorHeaders(tenantB) });
    expect((stranger.json() as { grants: unknown[] }).grants).toEqual([]);
    const strangerRevoke = await app.inject({ method: "POST", url: `/api/grants/${id}/revoke`, headers: operatorHeaders(tenantB), payload: {} });
    expect(strangerRevoke.statusCode).toBe(404);
    const wrongRole = await app.inject({ method: "GET", url: `/api/grants?subjectEntity=Envelope&subjectId=${envelopeId}`, headers: operatorHeaders(tenantId, ["General.All.Read"]) });
    expect(wrongRole.statusCode).toBe(403);

    const revoked = await app.inject({ method: "POST", url: `/api/grants/${id}/revoke`, headers: operatorHeaders(tenantId), payload: { reason: "Sent to the wrong address" } });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ id, status: "revoked" });
    const again = await app.inject({ method: "POST", url: `/api/grants/${id}/revoke`, headers: operatorHeaders(tenantId), payload: {} });
    expect(again.json()).toMatchObject({ id, status: "revoked" });
  }, TEST_TIMEOUT);

  test("expired, single-use and superseded grants refuse with their own codes; a failed handler leaves the grant usable", async () => {
    const envelopeId = randomUUID();
    const expired = await issue({ envelopeId, address: "late@example.test", expiresInSeconds: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await present(readOperation.transports.rest.path, expired.token)).toMatchObject({ status: 410, body: { error: { code: "GRANT_EXPIRED" } } });

    const single = await issue({ envelopeId, address: "once@example.test", maxUses: 1, operations: [signOperation.key] });
    // The handler fails after the grant was counted: the transaction rolls
    // the count back with it, so the grant is still usable.
    expect(await present(signOperation.transports.rest.path, single.token, { note: "fail" })).toMatchObject({ status: 500 });
    expect(await present(signOperation.transports.rest.path, single.token)).toMatchObject({ status: 200, body: { credential: "grant" } });
    expect(await present(signOperation.transports.rest.path, single.token)).toMatchObject({ status: 409, body: { error: { code: "GRANT_CONSUMED" } } });
    const signed = await withDbSession(
      runtime.db,
      { tenantId, userId: randomUUID(), roles: [], groups: [], scope: "tenant" },
      (trx) => sql<{ count: number }>`
        select count(*)::int as count from platform.entity_events
         where aggregate_type = 'envelope' and aggregate_id = ${envelopeId}
      `.execute(trx),
    );
    expect(signed.rows[0]!.count).toBe(1);

    const first = await issue({ envelopeId, address: "again@example.test" });
    const second = await issue({ envelopeId, address: "again@example.test", supersede: true });
    expect(await present(readOperation.transports.rest.path, first.token)).toMatchObject({ status: 410, body: { error: { code: "GRANT_REVOKED" } } });
    expect(await present(readOperation.transports.rest.path, second.token)).toMatchObject({ status: 200 });

    // Issuing joins the issuing Operation's transaction: a handler that fails
    // after issuing leaves no grant behind.
    const before = await app.inject({ method: "GET", url: `/api/grants?subjectEntity=Envelope&subjectId=${envelopeId}`, headers: operatorHeaders(tenantId) });
    const failed = await app.inject({ method: "POST", url: "/api/envelopes/links", headers: operatorHeaders(tenantId), payload: { envelopeId, address: "ghost@example.test", fail: true } });
    expect(failed.statusCode).toBe(409);
    const after = await app.inject({ method: "GET", url: `/api/grants?subjectEntity=Envelope&subjectId=${envelopeId}`, headers: operatorHeaders(tenantId) });
    expect((after.json() as { grants: unknown[] }).grants).toHaveLength((before.json() as { grants: unknown[] }).grants.length);
  }, TEST_TIMEOUT);
});
