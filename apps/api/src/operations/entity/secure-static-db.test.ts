// SPDX-License-Identifier: BUSL-1.1
/**
 * Static secure input end to end on a real database: collection through the
 * browser endpoints, sealed storage, rotation through the update Operation,
 * and resolution with a grant for the record's own URL. The Task entity plays
 * the plugin-style entity: its contract is given the declaration in memory,
 * exactly as `secure-completion-db.test.ts` does for the source form.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { sql } from "kysely";
import Fastify, { type FastifyInstance } from "fastify";
import { Writable } from "node:stream";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { applyAuditHistory, auditTableConfigs } from "../../db/migrations/audit-history.js";
import manifest from "../../generated/db/manifest.json" with { type: "json" };
import { registerConfigurationHandoffRoutes } from "../../mcp/configuration-handoff-routes.js";
import { withConnectionGrantSubject } from "../../mcp/connection-delegation.js";
import { ModulePlatformRuntime } from "../../modules/platform.js";
import type { ModuleEgressRequest } from "../../modules/contract.js";
import { withAuditContext } from "../../platform/audit-context.js";
import { toHttpError } from "../../rest/http-error.js";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import { completeEntitySecureInput, executeEntityOperation, getEntityOperationContracts } from "./runtime.js";
import { getGeneratedCrudTables } from "./catalog.js";
import type { GeneratedCrudTable } from "./types.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const name = `secure_static_${crypto.randomUUID().replaceAll("-", "")}`;
const KEYS = "OPENSHAPEFORGE_ELICITED_SECRET_KEYS";
const RESOLVER = "Task.send";
const STORED_URL = "https://93.184.216.34/hooks/in?channel=7";
const API_KEY = "plain-api-key-value-0001";
const SIGNING = "plain-signing-value-0002";
const ROTATED = "plain-api-key-value-0003";

const fields = [
  { key: "apiKey", osfType: "string" as const, required: true, label: { en: "API key" }, classification: { sensitivity: "confidential" as const } },
  { key: "signingSecret", osfType: "string" as const, label: { en: "Signing secret" }, classification: { sensitivity: "confidential" as const } },
  { key: "note", osfType: "string" as const },
];
const secure = { into: "metadata", fields, resolve: { operations: [RESOLVER], egress: { urlField: "openUrl" } }, rotation: true as const };

const table = getGeneratedCrudTables().find(t => t.source?.authoringEntityName === "Task")!;
const create = getEntityOperationContracts().find(o => o.id === "Task.create")!;
const update = getEntityOperationContracts().find(o => o.id === "Task.update")!;
const before = { interaction: create.interaction, concurrency: update.concurrency, secure: table.source!.secureInputOnCreate, mcp: table.source!.mcp, keys: process.env[KEYS] };

const tenant = crypto.randomUUID();
const person = { tenantId: tenant, userId: crypto.randomUUID(), roles: ["General.All.ReadWrite"], groups: [], oauthScopes: [], credential: "bearer" as const, scope: "tenant" as const };
/** Shaped like the organization service identity a durable worker executes a plugin Operation as. */
const service = { tenantId: tenant, userId: crypto.randomUUID(), roles: [], groups: [], oauthScopes: [], credential: "bearer" as const, scope: "tenant" as const,
  principalKind: "service" as const, organizationServiceIdentityId: "organization-service" } as unknown as TrustedSessionContext;
const foreign = { ...service, tenantId: crypto.randomUUID() } as TrustedSessionContext;

let admin: SQL, privileged: DatabaseRuntime, runtime: DatabaseRuntime, app: FastifyInstance, platform: ModulePlatformRuntime;
let issued: typeof person = person;
const logged: string[] = [];
const seen: ModuleEgressRequest[] = [];
let recordId = "";

const values = (overrides: Record<string, unknown> = {}) => ({ title: "Secure endpoint", type: "follow_up", status: "open", openUrl: STORED_URL, ...overrides });
const post = (url: string, payload: unknown, form = false) => app.inject({ method: "POST", url,
  headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
  payload: form ? String(payload) : JSON.stringify(payload) });
const stored = async (id = recordId) => (await sql<{ metadata: Record<string, unknown>; open_url: string; version: string }>`
  select metadata, open_url, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as version
  from erp.tasks where id=${id}::uuid`.execute(privileged.db)).rows[0]!;
/** Resolve inside a live Operation session, as the named canonical Operation. */
const resolve = (session: TrustedSessionContext, id: string, operation: string | null = RESOLVER, entity = "Task") =>
  platform.withActiveOperationSession(session, live => {
    const work = () => platform.services.secrets.resolveEntityValues(live, { entity, id });
    return operation ? withAuditContext(operation, undefined, work) : work();
  });

beforeAll(async () => {
  const url = new URL(adminUrl);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/postgres") throw Error("Isolated local admin database required");
  process.env[KEYS] = `test:${Buffer.alloc(32, 7).toString("base64")}`;
  admin = new SQL(adminUrl);
  await admin.unsafe(`create database "${name}"`);
  url.pathname = `/${name}`;
  privileged = createDatabaseRuntime({ databaseUrl: url.href });
  await privileged.db.connection().execute(connection => runMigrationChain(connection));
  // The audit trigger is configured from the manifest: give it the same declaration.
  await applyAuditHistory(privileged.db, (manifest.tables as unknown as GeneratedCrudTable[])
    .map(t => t.name === table.name ? { ...t, source: { ...t.source!, secureInputOnCreate: secure } } : t));
  url.username = "openshapeforge_app"; url.password = "openshapeforge_app";
  runtime = createDatabaseRuntime({ databaseUrl: url.href });
  create.interaction = { ...before.interaction, secureInput: { type: "secureInput", ...secure } };
  update.concurrency = { version: { mode: "required", field: "updatedAt" } };
  table.source!.secureInputOnCreate = secure;
  table.source!.mcp = { ...before.mcp, elicitOnCreate: secure } as NonNullable<typeof before.mcp>;
  platform = new ModulePlatformRuntime(runtime.db);
  platform.registerEgressOwner({ pinsResolvedAddresses: true, fetch: async request => { seen.push(request); return Response.json({ received: true }); } });
  app = Fastify({ routerOptions: { maxParamLength: 512 },
    logger: { level: "trace", stream: new Writable({ write(chunk, _encoding, done) { logged.push(String(chunk)); done(); } }) } });
  // The server's own translation of refusals, and its habit of logging them.
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "request failed");
    const { status, body } = toHttpError(error);
    return reply.status(status).send(body);
  });
  await registerConfigurationHandoffRoutes({ instance: app, options: { db: runtime.db },
    requireMcpSession: async () => ({ db: runtime.db, session: issued, resource: "/api/mcp" }) } as never);
}, 180_000);

afterAll(async () => {
  create.interaction = before.interaction;
  if (before.concurrency) update.concurrency = before.concurrency; else delete update.concurrency;
  if (before.secure) table.source!.secureInputOnCreate = before.secure; else delete table.source!.secureInputOnCreate;
  if (before.mcp) table.source!.mcp = before.mcp; else delete table.source!.mcp;
  if (before.keys === undefined) delete process.env[KEYS]; else process.env[KEYS] = before.keys;
  await app?.close(); await runtime?.close(); await privileged?.close();
  await admin?.unsafe(`drop database if exists "${name}" with(force)`); await admin?.close();
});

test("the audit configuration hides the secure column by declaration, not by its name", () => {
  const patched = (manifest.tables as unknown as GeneratedCrudTable[])
    .map(t => t.name === table.name ? { ...t, source: { ...t.source!, secureInputOnCreate: secure } } : t);
  const undeclared = patched.map(t => {
    if (t.name !== table.name) return t;
    const { secureInputOnCreate: _declared, ...source } = t.source!;
    return { ...t, source };
  });
  const plain = auditTableConfigs(undeclared).find(config => config.entity === "Task")!;
  const hidden = auditTableConfigs(patched).find(config => config.entity === "Task")!;
  expect(plain.fields.metadata).toEqual({ name: "metadata", hidden: false, exact: false });
  expect(hidden.fields.metadata).toEqual({ name: "metadata", hidden: true, exact: false });
  expect(hidden.visibility).not.toContain("metadata");
});

test("an ordinary create answers with everything a client needs to render the secure fields", async () => {
  const result = await executeEntityOperation(runtime.db, person, { operation: { id: create.id, intent: "create" }, input: { values: values() } });
  expect(result).toMatchObject({ error: { code: "INTERACTION_REQUIRED", data: { interaction: {
    kind: "secureInput", into: "metadata", rotation: true,
    fields: [
      { key: "apiKey", osfType: "string", required: true, label: { en: "API key" }, classification: { sensitivity: "confidential" } },
      { key: "signingSecret", osfType: "string", classification: { sensitivity: "confidential" } },
      { key: "note", osfType: "string" },
    ] } } } });
  // The target stays server-owned on the ordinary path.
  expect(await executeEntityOperation(runtime.db, person, { operation: { id: create.id, intent: "create" },
    input: { values: values({ metadata: { apiKey: API_KEY } }) } })).toMatchObject({ error: { code: expect.stringMatching(/FORBIDDEN|BAD_USER_INPUT|VALIDATION/) } });
});

test("a destination that cannot be one is refused before anyone enters a secret", async () => {
  for (const openUrl of ["http://93.184.216.34/hooks", "https://user:pw@hooks.example.com/in", "https://*.example.com/in", "https://hooks.example.com/in#x"]) {
    const refused = await post("/api/entity-configuration/start", { entity: "Task", values: values({ openUrl }) });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain("Credentials belong in a header");
  }
});

test("static create collects through the two calls and stores only ciphertext", async () => {
  const started = await post("/api/entity-configuration/start", { entity: "Task", values: values() });
  expect(started.statusCode).toBe(200);
  const formId = started.json().id as string;
  expect(started.json() as unknown).toEqual({ id: formId, expiresInSeconds: expect.any(Number) });

  const form = (await app.inject({ method: "GET", url: `/api/entity-configuration/pending/${formId}` })).json();
  expect(form).toMatchObject({ id: formId, mode: "create", displayName: expect.any(String) });
  expect(form.recordId).toBeUndefined();
  expect(form.definitions).toEqual([
    { key: "apiKey", osfType: "string", required: true, label: { en: "API key" }, classification: { sensitivity: "confidential" }, secret: true, schema: { type: "string", title: "API key" } },
    { key: "signingSecret", osfType: "string", label: { en: "Signing secret" }, classification: { sensitivity: "confidential" }, secret: true, schema: { type: "string", title: "Signing secret" } },
    { key: "note", osfType: "string", secret: false, schema: { type: "string" } },
  ]);

  // A missing required value is a correctable refusal and leaves the form open.
  const incomplete = await post(`/api/entity-configuration/pending/${formId}`, `signingSecret=${SIGNING}`, true);
  expect(incomplete.statusCode).toBe(400);
  expect(incomplete.json()).toMatchObject({ error: { code: "INVALID_CONFIGURATION", fields: { apiKey: expect.any(String) } } });
  // Another tenant's session cannot see or submit the form.
  issued = { ...person, tenantId: crypto.randomUUID() };
  expect((await app.inject({ method: "GET", url: `/api/entity-configuration/pending/${formId}` })).statusCode).toBe(404);
  expect((await post(`/api/entity-configuration/pending/${formId}`, `apiKey=${API_KEY}`, true)).statusCode).toBe(404);
  issued = person;

  const saved = await post(`/api/entity-configuration/pending/${formId}`, `apiKey=${API_KEY}&signingSecret=${SIGNING}&note=visible`, true);
  expect(saved.statusCode).toBe(200);
  expect(saved.json() as unknown).toEqual({ saved: true, id: expect.any(String) });
  recordId = saved.json().id;
  // Single use.
  expect((await post(`/api/entity-configuration/pending/${formId}`, `apiKey=${API_KEY}`, true)).statusCode).toBe(404);

  const row = await stored();
  expect(row.metadata).toMatchObject({ note: "visible",
    apiKey: { ciphertext: expect.any(String), keyId: "test", algorithm: "aes-256-gcm" },
    signingSecret: { ciphertext: expect.any(String), keyId: "test", algorithm: "aes-256-gcm" } });
  expect(JSON.stringify(row)).not.toContain(API_KEY);
  expect(JSON.stringify(row)).not.toContain(SIGNING);

  // Every read returns set markers, never plaintext or ciphertext.
  const read = await executeEntityOperation(runtime.db, person, { operation: { id: "Task.get", intent: "get" }, input: { id: recordId } });
  if ("error" in read) throw Error(JSON.stringify(read.error));
  expect((read.data as Record<string, unknown>).metadata).toEqual({ apiKey: "__set__", signingSecret: "__set__", note: "visible" });
});

test("the service identity resolves its tenant's record and sends to the stored URL only", async () => {
  const resolved = await resolve(service, recordId);
  if (!resolved.ok) throw Error(JSON.stringify(resolved));
  expect(resolved.record).toMatchObject({ entity: "Task", id: recordId, url: STORED_URL,
    values: { apiKey: API_KEY, signingSecret: SIGNING, note: "visible" }, secretKeys: ["apiKey", "signingSecret"] });

  // The grant is single use and belongs to the session that resolved it.
  const sent = await platform.withActiveOperationSession(service, async live => {
    const again = await withAuditContext(RESOLVER, undefined, () => platform.services.secrets.resolveEntityValues(live, { entity: "Task", id: recordId }));
    if (!again.ok) throw Error(again.code);
    const first = await platform.services.egress.request(live, again.record.egressGrant,
      { url: again.record.url, json: { event: "created" }, headers: { "x-api-key": again.record.values.apiKey! } });
    const reused = await platform.services.egress.request(live, again.record.egressGrant, { url: again.record.url, json: {} })
      .then(() => "sent", (error: unknown) => (error as { code?: string }).code);
    const elsewhere = await withAuditContext(RESOLVER, undefined, () => platform.services.secrets.resolveEntityValues(live, { entity: "Task", id: recordId }));
    if (!elsewhere.ok) throw Error(elsewhere.code);
    const other = await platform.services.egress.request(live, elsewhere.record.egressGrant, { url: "https://93.184.216.35/hooks/in?channel=7", json: {} })
      .then(() => "sent", (error: unknown) => (error as { code?: string }).code);
    return { first, reused, other };
  });
  expect(sent).toMatchObject({ first: { status: 200 }, reused: "EGRESS_DENIED", other: "EGRESS_DENIED" });
  expect(seen).toHaveLength(1);
  expect(seen[0]!.url.href).toBe(STORED_URL);
  expect(seen[0]!.allowlist).toEqual(["93.184.216.34"]);
  expect(seen[0]!.resolvedAddresses).toEqual(["93.184.216.34"]);
  expect(seen[0]!.purpose).toBe("provider");
  expect(seen[0]!.source).toBeUndefined();
  expect(seen[0]!.scope).toEqual({ tenantId: tenant, actorId: service.userId, provider: "Task", operation: "entity.http", kind: "mutation" });
});

test("resolution is refused for another tenant, Operation, record, entity or a retained session", async () => {
  // Row-level security: another tenant's service identity sees no such record.
  expect(await resolve(foreign, recordId)).toMatchObject({ ok: false, code: "NOT_FOUND" });
  expect(await resolve(service, crypto.randomUUID())).toMatchObject({ ok: false, code: "NOT_FOUND" });
  // Only the Operations the entity names, and only while one of them executes.
  expect(await resolve(service, recordId, "Task.update")).toMatchObject({ ok: false, code: "FORBIDDEN" });
  expect(await resolve(service, recordId, "Other.send")).toMatchObject({ ok: false, code: "FORBIDDEN" });
  expect(await resolve(service, recordId, null)).toMatchObject({ ok: false, code: "FORBIDDEN" });
  // An entity that declares no resolve, and one that does not exist, answer alike.
  expect(await resolve(service, recordId, RESOLVER, "Relation")).toMatchObject({ ok: false, code: "NOT_FOUND" });
  expect(await resolve(service, recordId, RESOLVER, "NoSuchEntity")).toMatchObject({ ok: false, code: "NOT_FOUND" });
  expect(await resolve(service, "not-a-uuid")).toMatchObject({ ok: false, code: "NOT_FOUND" });
  // A record-targeted Operation opens the record it was invoked for, and no other.
  const targeted = (target: string) => withConnectionGrantSubject({ entity: "Task", id: target }, () => resolve(service, recordId));
  expect(await targeted(crypto.randomUUID())).toMatchObject({ ok: false, code: "FORBIDDEN" });
  expect(await targeted(recordId)).toMatchObject({ ok: true });
  // A handle kept past its Operation opens nothing.
  let retained: TrustedSessionContext | undefined;
  await platform.withActiveOperationSession(service, async live => { retained = live; });
  await expect(withAuditContext(RESOLVER, undefined, () => platform.services.secrets.resolveEntityValues(retained!, { entity: "Task", id: recordId })))
    .rejects.toThrow("live verified session");
  await expect(withAuditContext(RESOLVER, undefined, () => platform.services.secrets.resolveEntityValues(service, { entity: "Task", id: recordId })))
    .rejects.toThrow("live verified session");
});

test("rotation replaces entered values through the update Operation and keeps the rest", async () => {
  const version = (await stored()).version;
  // Another tenant, and a person without the update role, cannot start it.
  issued = { ...person, tenantId: crypto.randomUUID() };
  expect((await post("/api/entity-configuration/start", { entity: "Task", id: recordId, expectedVersion: version })).statusCode).toBe(404);
  issued = { ...person, roles: ["General.All.Read"] };
  expect((await post("/api/entity-configuration/start", { entity: "Task", id: recordId, expectedVersion: version })).statusCode).toBe(403);
  issued = person;
  expect((await post("/api/entity-configuration/start", { entity: "Task", id: recordId })).statusCode).toBe(400);
  expect((await post("/api/entity-configuration/start", { entity: "Task", id: recordId, expectedVersion: version, values: {} })).statusCode).toBe(400);

  const started = await post("/api/entity-configuration/start", { entity: "Task", id: recordId, expectedVersion: version });
  expect(started.statusCode).toBe(200);
  const formId = started.json().id as string;
  const form = (await app.inject({ method: "GET", url: `/api/entity-configuration/pending/${formId}` })).json();
  expect(form).toMatchObject({ id: formId, mode: "rotate", recordId });
  expect(form.definitions.map((definition: { key: string; required: boolean; secret: boolean }) => [definition.key, definition.required, definition.secret]))
    .toEqual([["apiKey", false, true], ["signingSecret", false, true], ["note", false, false]]);

  const empty = await post(`/api/entity-configuration/pending/${formId}`, "", true);
  expect(empty.statusCode).toBe(400);
  expect(empty.json()).toMatchObject({ error: { code: "INVALID_CONFIGURATION", message: "Enter at least one value to replace." } });
  const saved = await post(`/api/entity-configuration/pending/${formId}`, `apiKey=${ROTATED}`, true);
  expect(saved.statusCode).toBe(200);
  expect(saved.json() as unknown).toEqual({ saved: true, id: recordId });

  const resolved = await resolve(service, recordId);
  if (!resolved.ok) throw Error(JSON.stringify(resolved));
  expect(resolved.record.values).toEqual({ apiKey: ROTATED, signingSecret: SIGNING, note: "visible" });
  expect((await stored()).open_url).toBe(STORED_URL);

  // A form started from a version that has since moved writes nothing.
  const stale = await post("/api/entity-configuration/start", { entity: "Task", id: recordId, expectedVersion: version });
  expect(stale.statusCode).toBe(200);
  const refused = await post(`/api/entity-configuration/pending/${stale.json().id}`, "apiKey=never-stored", true);
  expect(refused.statusCode).toBe(409);
  const after = await resolve(service, recordId);
  expect(after.ok && after.record.values.apiKey).toBe(ROTATED);
});

test("a create continuation and an ordinary update can never write the secure target", async () => {
  const version = (await stored()).version;
  expect(await completeEntitySecureInput(runtime.db, person, { operation: { id: create.id, intent: "create" }, input: { values: values() } },
    { into: "metadata", value: { apiKey: "overwrite" }, existingId: recordId })).toMatchObject({ error: { code: "FORBIDDEN" } });
  expect(await completeEntitySecureInput(runtime.db, person, { operation: { id: update.id, intent: "update" },
    input: { id: recordId, expectedVersion: version, values: { title: "smuggled" } } },
    { into: "metadata", value: { apiKey: "overwrite" }, existingId: recordId })).toMatchObject({ error: { code: "BAD_USER_INPUT" } });
  expect(await completeEntitySecureInput(runtime.db, person, { operation: { id: update.id, intent: "update" },
    input: { id: recordId, expectedVersion: version, values: {} } },
    { into: "metadata", value: { apiKey: "overwrite" }, existingId: crypto.randomUUID() })).toMatchObject({ error: { code: "BAD_USER_INPUT" } });
  expect(await executeEntityOperation(runtime.db, person, { operation: { id: update.id, intent: "update" },
    input: { id: recordId, expectedVersion: version, values: { metadata: { apiKey: "overwrite" } } } })).toMatchObject({ error: { code: expect.any(String) } });
  // An ordinary update needs no secure form and leaves the values alone.
  const renamed = await executeEntityOperation(runtime.db, person, { operation: { id: update.id, intent: "update" },
    input: { id: recordId, expectedVersion: version, values: { title: "Renamed endpoint" } } });
  expect("error" in renamed).toBe(false);
  const resolved = await resolve(service, recordId);
  expect(resolved.ok && resolved.record.values.apiKey).toBe(ROTATED);
});

test("values entered for one destination do not open for another", async () => {
  const move = async (openUrl: string) => {
    const result = await executeEntityOperation(runtime.db, person, { operation: { id: update.id, intent: "update" },
      input: { id: recordId, expectedVersion: (await stored()).version, values: { openUrl } } });
    if ("error" in result) throw Error(JSON.stringify(result.error));
  };
  await move("https://93.184.216.35/hooks/in");
  expect(await resolve(service, recordId)).toMatchObject({ ok: false, code: "SECRET_REENTRY_REQUIRED" });
  await move("http://93.184.216.34/hooks/in");
  expect(await resolve(service, recordId)).toMatchObject({ ok: false, code: "EGRESS_TARGET_INVALID" });
  // Rotation for a record that cannot be a destination is refused before the form.
  expect((await post("/api/entity-configuration/start", { entity: "Task", id: recordId, expectedVersion: (await stored()).version })).statusCode).toBe(400);
  // The same path on the original origin opens again; nothing was lost.
  await move("https://93.184.216.34/other/path");
  const back = await resolve(service, recordId);
  expect(back.ok && back.record.url).toBe("https://93.184.216.34/other/path");
  // Entering every value again binds them to the new destination.
  await move("https://93.184.216.35/hooks/in");
  const started = await post("/api/entity-configuration/start", { entity: "Task", id: recordId, expectedVersion: (await stored()).version });
  expect((await post(`/api/entity-configuration/pending/${started.json().id}`, `apiKey=${API_KEY}&signingSecret=${SIGNING}&note=visible`, true)).statusCode).toBe(200);
  const rebound = await resolve(service, recordId);
  expect(rebound).toMatchObject({ ok: true, record: { url: "https://93.184.216.35/hooks/in", values: { apiKey: API_KEY, signingSecret: SIGNING } } });
});

test("no plaintext or ciphertext reaches the audit journal, entity events or the request log", async () => {
  const events = await sql<{ payload: unknown; event_type: string }>`
    select payload, event_type from platform.entity_events where tenant_id=${tenant}::uuid`.execute(privileged.db);
  expect(events.rows.length).toBeGreaterThan(0);
  const journal = JSON.stringify(events.rows);
  const row = await stored();
  const ciphertexts = Object.values(row.metadata)
    .filter((value): value is { ciphertext: string } => typeof value === "object" && value !== null && "ciphertext" in value)
    .map(value => value.ciphertext);
  expect(ciphertexts.length).toBe(2);
  const requestLog = logged.join("");
  expect(requestLog.length).toBeGreaterThan(0);
  for (const secret of [API_KEY, SIGNING, ROTATED, ...ciphertexts]) {
    expect(journal).not.toContain(secret);
    expect(requestLog).not.toContain(secret);
  }
  // The audited record shows the secure column as redacted, in every before/after image.
  expect(journal).not.toContain("ciphertext");
  expect(journal).not.toContain("aes-256-gcm");
  expect(journal).toContain("[REDACTED]");
});
