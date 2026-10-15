// SPDX-License-Identifier: BUSL-1.1
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import Fastify from "fastify";
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from "kysely";
import type { RuntimeOperationDefinition } from "@openshapeforge/plugin-runtime";
import type { DB } from "../generated/db/types.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { __resetSessionResolverForTests, __setIdentityLinkForTests } from "../auth/identity.js";
import { __setTenantForOrganizationForTests } from "../auth/tenant-resolution.js";
import { stubLinkedMembershipForTests } from "../auth/identity-link.test-support.js";
import { notInvited } from "../auth/identity-link-admission.js";
import { createGraphqlContext } from "../graphql/context.js";
import { createControlRuntime } from "../control/runtime.js";
import { ModulePlatformRuntime } from "../modules/platform.js";
import type { RuntimeModule } from "../modules/contract.js";
import { operationGraphqlContribution, registerRuntimeOperationRestRoutes, runtimeStaticOperationRegistrations, type OperationContract } from "./runtime.js";

const issuer = "https://identity.example.test/realms/dual-context";
const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const names = ["OPENSHAPEFORGE_ORGANIZATION_CONTEXT", "OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER", "OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI", "OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE", "OPENSHAPEFORGE_API_VERIFY_BEARER_AUTHORIZED_PARTIES"] as const;
const saved = new Map(names.map(name => [name, process.env[name]]));
let privateKey: KeyObject;
let badKey: KeyObject;
let jwks: ReturnType<typeof Bun.serve>;
let app: ReturnType<typeof Fastify>;
let db: Kysely<DB>;
let platform: ModulePlatformRuntime;
const writes: TrustedSessionContext[] = [];
const controls: TrustedSessionContext[] = [];
const providerDefinition: RuntimeOperationDefinition = {
  id: "example.definition.save", intent: "invoke", name: "Save definition", description: "Save an organization definition.",
  input: { kind: "json-schema", schema: { type: "object" } }, output: { kind: "json-schema", schema: { type: "object" } },
  effects: { data: "write", external: "none" }, reliability: { idempotency: { mode: "none" } }, interaction: { confirmation: { mode: "none" } },
};
const controlOperation: OperationContract = {
  key: "example.control.inspect", plugin: "example", title: "Inspect platform", description: "Inspect the platform.", handler: "inspect",
  inputSchema: { type: "object", additionalProperties: false }, outputSchema: { type: "object", additionalProperties: true }, errors: [],
  auth: { mode: "control", roles: ["platform-operator"] }, tenancy: { mode: "none" }, idempotency: { mode: "none" }, effects: { data: "read", external: "none" },
  transports: { rest: { method: "POST", path: "/api/control/example-inspect", response: { status: 200, kind: "json" } },
    mcp: { enabled: false, reason: "REST test." }, graphql: { enabled: false, reason: "REST test." }, typescript: { enabled: false, reason: "REST test." } },
};
function bearer(overrides: Record<string, unknown> = {}, invalidSignature = false) {
  const claims = { iss: issuer, aud: ["api"], azp: "web", sub: userId, preferred_username: "example-member", scope: "openid organization",
    organization: { alpha: { id: "org-a" } }, resource_access: { "realm-management": { roles: ["realm-admin"] } },
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, ...overrides };
  const input = [JSON.stringify({ alg: "RS256", kid: "example-key" }), JSON.stringify(claims)].map(x => Buffer.from(x).toString("base64url")).join(".");
  return { authorization: `Bearer ${input}.${sign("RSA-SHA256", Buffer.from(input), invalidSignature ? badKey : privateKey).toString("base64url")}` };
}
const execute = (id: string, headers = bearer(), input: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: `/api/operations/${id}/execute`, headers, payload: { intent: "invoke", input } });
beforeAll(() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 }); privateKey = pair.privateKey; badKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const publicKey = { ...pair.publicKey.export({ format: "jwk" }), kid: "example-key", alg: "RS256" };
  jwks = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [publicKey] }) });
});
beforeEach(() => {
  process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT = "host";
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = issuer;
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI = jwks.url.href;
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE = "api";
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUTHORIZED_PARTIES = "web";
  __resetSessionResolverForTests(); stubLinkedMembershipForTests(["Example.Definitions.Manage"]);
  __setTenantForOrganizationForTests(async (_realm, id) => ({ "org-a": tenantA, "org-b": tenantB }[id] ?? null));
  db = new Kysely<DB>({ dialect: { createAdapter: () => new PostgresAdapter(), createDriver: () => new DummyDriver(), createIntrospector: database => new PostgresIntrospector(database), createQueryCompiler: () => new PostgresQueryCompiler() } });
  platform = new ModulePlatformRuntime(db); writes.length = 0; controls.length = 0;
  const allowed = (session: { tenantId?: string | null; roles: readonly string[] }) => session.tenantId === tenantA && session.roles.includes("Example.Definitions.Manage");
  platform.registerOperationProviders([{ name: "example", operationProviders: [{ id: "example.definitions",
    list: async session => allowed(session) ? [providerDefinition] : [],
    get: async (session, id) => id === providerDefinition.id && allowed(session) ? providerDefinition : undefined,
    execute: async context => { writes.push(context.session as TrustedSessionContext); return { data: { saved: true, tenantId: context.session.tenantId }, operations: [] }; },
  }] }]);
  const module: RuntimeModule = { name: "example", operationHandlers: { inspect: async (_input, context) => { controls.push(context.session!); return { value: { inspected: true } }; } } };
  platform.registerStaticOperations(runtimeStaticOperationRegistrations([module], { db, platform: platform.services }, [controlOperation]));
  const control = createControlRuntime({ config: { ok: true, config: {
    keycloak: { baseUrl: "https://identity.example.test", tenantRealm: "dual-context", clientId: "auth-api", clientSecret: "synthetic-not-used" },
    operator: { issuer, jwksUri: jwks.url.href, clientId: "web" }, mcpResource: { origins: ["https://api.example.test"], clients: [] },
  } }, operations: [] });
  app = Fastify(); registerRuntimeOperationRestRoutes(app, { db, platform: platform.services, control });
});
afterEach(async () => { await app.close(); await db.destroy(); for (const name of names) { const value = saved.get(name); if (value === undefined) delete process.env[name]; else process.env[name] = value; } __resetSessionResolverForTests(); });
afterAll(() => jwks.stop(true));

test("a verified dual-role member discovers, reads and saves the tenant provider Operation", async () => {
  const catalog = await app.inject({ method: "GET", url: "/api/operations", headers: bearer() });
  expect(catalog.statusCode).toBe(200); expect(catalog.json().map((x: { id: string }) => x.id)).toEqual([providerDefinition.id]);
  const definition = await app.inject({ method: "GET", url: `/api/operations/${providerDefinition.id}`, headers: bearer() });
  expect(definition.statusCode).toBe(200); expect(definition.json().id).toBe(providerDefinition.id);
  const response = await execute(providerDefinition.id); expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ data: { saved: true, tenantId: tenantA } });
  expect(writes).toHaveLength(1); expect(writes[0]).toMatchObject({ credential: "bearer", tenantId: tenantA, roles: ["Example.Definitions.Manage"] }); expect(controls).toHaveLength(0);
});
test("the same dual-role identity uses only its control credential for a canonical control Operation", async () => {
  const definition = await app.inject({ method: "GET", url: `/api/operations/${controlOperation.key}`, headers: bearer() }); expect(definition.statusCode).toBe(200);
  const response = await execute(controlOperation.key); expect(response.json()).toMatchObject({ data: { inspected: true } });
  expect(controls).toHaveLength(1); expect(controls[0]).toMatchObject({ credential: "control-bearer", tenantId: null, roles: ["platform-operator"] }); expect(writes).toHaveLength(0);
});
test("tenant membership cannot substitute for the required control credential", async () => {
  const headers = bearer({ resource_access: {} });
  expect((await execute(controlOperation.key, headers)).json()).toMatchObject({ error: { code: "OPERATION_NOT_FOUND" } });
  expect(controls).toHaveLength(0); expect(writes).toHaveLength(0);
});
test("a pure control credential discovers control only and cannot invoke a tenant provider", async () => {
  const headers = bearer({ organization: undefined, scope: "openid" });
  const catalog = await app.inject({ method: "GET", url: "/api/operations", headers }); expect(catalog.statusCode).toBe(200); expect(catalog.json().map((x: { id: string }) => x.id)).toEqual([controlOperation.key]);
  expect((await execute(providerDefinition.id, headers)).statusCode).toBe(404); expect(writes).toHaveLength(0);
  expect((await execute(controlOperation.key, headers)).json()).toMatchObject({ data: { inspected: true } });
});
test("an available static definition without canonical control auth provenance cannot use control fallback", async () => {
  platform.registerStaticOperations([{ definition: { ...providerDefinition, id: "example.unclassified" }, available: s => s.credential === "control-bearer", execute: async () => { throw new Error("Unclassified control execution must never run"); } }]);
  const response = await execute("example.unclassified", bearer({ organization: undefined, scope: "openid" })); expect(response.statusCode).toBe(404); expect(writes).toHaveLength(0);
});
test.each([
  ["invalid signature", {}, true],
  ["wrong tenant audience", { aud: ["another-api"] }, false],
  ["unauthorized client", { azp: "another-client" }, false],
  ["unprovisioned organization", { organization: { unknown: { id: "unknown" } } }, false],
  ["another organization", { organization: { beta: { id: "org-b" } } }, false],
  ["conflicting signed tenant", { tid: tenantB }, false],
])("%s never executes a tenant provider", async (_label, claims, invalid) => {
  const response = await execute(providerDefinition.id, bearer(claims as Record<string, unknown>, invalid as boolean)); expect(response.statusCode >= 400 || !!response.json().error).toBe(true); expect(writes).toHaveLength(0); expect(controls).toHaveLength(0);
});
test("tenant role and admission refusals are preserved and never retried as platform execution", async () => {
  stubLinkedMembershipForTests([]);
  expect((await execute(providerDefinition.id)).json()).toMatchObject({ error: { code: "OPERATION_NOT_FOUND" } }); expect(writes).toHaveLength(0);
  __setIdentityLinkForTests(async (session, claims) => { throw notInvited(session, claims); });
  const response = await execute(providerDefinition.id); expect(response.statusCode).toBe(403); expect(response.json()).toMatchObject({ error: { code: "NOT_INVITED" } }); expect(writes).toHaveLength(0);
});
test("a tenant business failure is returned once without retrying another context", async () => {
  platform.registerOperationProviders([{ name: "example", operationProviders: [{ id: "example.refusal", list: async () => [providerDefinition], get: async () => providerDefinition, execute: async context => { writes.push(context.session as TrustedSessionContext); return { error: { code: "CONFLICT", message: "Definition changed.", retryable: false } }; } }] }]);
  const response = await execute(providerDefinition.id); expect(response.json()).toMatchObject({ error: { code: "CONFLICT" } }); expect(writes).toHaveLength(1); expect(controls).toHaveLength(0);
});
test("GraphQL already preserves the same verified dual-role tenant context", async () => {
  const context = await createGraphqlContext(new Headers(bearer()), { db });
  const contribution = operationGraphqlContribution([], { db, platform: platform.services })!.graphql!({ db, platform: platform.services });
  const definition = contribution.resolvers!.Query!.operationDefinition as
    (parent: unknown, args: { id: string }, context: Awaited<ReturnType<typeof createGraphqlContext>>) => Promise<RuntimeOperationDefinition>;
  const executeOperation = contribution.resolvers!.Mutation!.executeOperation as
    (parent: unknown, args: { id: string; intent: string; input: Record<string, unknown> }, context: Awaited<ReturnType<typeof createGraphqlContext>>) => Promise<unknown>;
  expect((await definition(null, { id: providerDefinition.id }, context)).id).toBe(providerDefinition.id);
  expect(await executeOperation(null, { id: providerDefinition.id, intent: "invoke", input: {} }, context)).toMatchObject({ data: { saved: true } });
  expect(writes[0]).toMatchObject({ credential: "bearer", tenantId: tenantA }); expect(controls).toHaveLength(0);
});
