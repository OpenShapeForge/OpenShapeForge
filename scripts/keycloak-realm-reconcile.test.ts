// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  reconcileKeycloakRealm, RealmReconcileError, validateRealmManifest,
  type KeycloakRestAdapter, type RealmManifest, type RestRequest, type RestResponse,
} from "./keycloak-realm-reconcile";

type Row = Record<string, unknown>;
const root = "/admin/realms/example";
const manifest = (): RealmManifest => ({
  version: 1, realm: "example", settings: { verifyEmail: true },
  clients: [{ clientId: "web", enabled: true, redirectUris: ["https://app.example.test/callback"] }],
  clientScopes: [{ name: "app-read", description: "Read application data", protocol: "openid-connect" }],
  realmRoles: [{ name: "reader", description: "Read access" }],
});

/** Models partial object PUTs and server-assigned IDs; forbids every other route. */
class FakeRest implements KeycloakRestAdapter {
  calls: RestRequest[] = [];
  realm: Row | undefined = { id: "realm-1", realm: "example", verifyEmail: false };
  clients: Row[] = [{ id: "client-1", clientId: "web", enabled: false,
    secret: "synthetic-secret", attributes: { unmanaged: "keep" }, protocolMappers: [{ id: "mapper-1" }] },
  { id: "dynamic-1", clientId: "dcr-runtime", registrationAccessToken: "synthetic-token" }];
  scopes: Row[] = [{ id: "scope-1", name: "app-read", description: "Old description", protocol: "openid-connect" },
    { id: "runtime-scope", name: "mcp-resource:example" }];
  roles: Row[] = [{ id: "role-1", name: "reader", clientRole: false, description: "Old description", composite: true },
    { id: "runtime-role", name: "organization:sample:role:reader", clientRole: false }];
  runtime = { users: [{ id: "user-1" }], organizations: [{ id: "org-1" }],
    groups: [{ id: "group-1" }], memberships: [{ user: "user-1", organization: "org-1" }] };
  intercept?: (request: RestRequest) => RestResponse | undefined;
  get writes() { return this.calls.filter((call) => call.method !== "GET"); }
  async request(request: RestRequest): Promise<RestResponse> {
    this.calls.push(structuredClone(request));
    const intercepted = this.intercept?.(request);
    if (intercepted) return structuredClone(intercepted);
    const { method, path, body } = request;
    if (path === "/admin/realms" && method === "POST") {
      if (this.realm) return { status: 409 };
      this.realm = { id: "created-realm", ...body };
      return { status: 201 };
    }
    if (path === root) {
      if (!this.realm) return { status: 404 };
      if (method === "GET") return { status: 200, body: structuredClone(this.realm) };
      if (method === "PUT") { Object.assign(this.realm, body); return { status: 204 }; }
    }
    const url = new URL(path, "https://keycloak.example.test");
    if (url.pathname === `${root}/clients` && method === "GET") {
      return { status: 200, body: structuredClone(this.clients.filter((row) => row.clientId === url.searchParams.get("clientId"))) };
    }
    for (const [suffix, rows] of [["clients", this.clients], ["client-scopes", this.scopes], ["roles", this.roles]] as const) {
      const base = `${root}/${suffix}`;
      if (path === base) {
        if (method === "GET" && suffix === "client-scopes") return { status: 200, body: structuredClone(rows) };
        if (method === "POST") {
          rows.push({ id: `${suffix}-${rows.length + 1}`, ...(suffix === "roles" ? { clientRole: false } : {}), ...body });
          return { status: 201 };
        }
      }
      if (path.startsWith(`${base}/`)) {
        const identity = decodeURIComponent(path.slice(base.length + 1));
        const row = rows.find((row) => row[suffix === "roles" ? "name" : "id"] === identity);
        if (!row) return { status: 404 };
        if (method === "GET") return { status: 200, body: structuredClone(row) };
        if (method === "PUT") { Object.assign(row, body); return { status: 204 }; }
      }
    }
    throw new Error("Unexpected endpoint");
  }
}
const run = (input: unknown, rest: FakeRest, mode: "plan" | "apply" = "apply", bootstrapMissingRealm = false) =>
  reconcileKeycloakRealm(input, rest, { expectedRealm: "example", mode, bootstrapMissingRealm });

describe("bounded realm reconciliation", () => {
  test("plan is read-only and omits values and server secrets", async () => {
    const rest = new FakeRest();
    const report = await run(manifest(), rest, "plan");
    expect(report.changes.map((row) => row.action)).toEqual(["update", "update", "update", "update"]);
    expect(report.applied).toBe(0);
    expect(rest.writes).toHaveLength(0);
    expect(JSON.stringify(report)).not.toContain("synthetic");
    expect(JSON.stringify(report)).not.toContain("https://");
  });

  test("apply preserves UUIDs, runtime state, unmanaged objects and fields; repeat is a no-op", async () => {
    const rest = new FakeRest();
    const runtime = structuredClone(rest.runtime);
    const dynamic = structuredClone(rest.clients[1]);
    const scope = structuredClone(rest.scopes[1]);
    const role = structuredClone(rest.roles[1]);
    expect((await run(manifest(), rest)).applied).toBe(4);
    expect(rest.clients[0]).toMatchObject({ id: "client-1", enabled: true, secret: "synthetic-secret",
      attributes: { unmanaged: "keep" }, protocolMappers: [{ id: "mapper-1" }] });
    expect(rest.scopes[0]?.id).toBe("scope-1");
    expect(rest.roles[0]).toMatchObject({ id: "role-1", composite: true });
    expect(rest.clients[1]).toEqual(dynamic);
    expect(rest.scopes[1]).toEqual(scope);
    expect(rest.roles[1]).toEqual(role);
    expect(rest.runtime).toEqual(runtime);
    expect(rest.writes.every((row) => row.method === "PUT")).toBe(true);
    expect(JSON.stringify(rest.writes)).not.toContain("synthetic");
    const count = rest.writes.length;
    expect((await run(manifest(), rest)).changes.every((row) => row.action === "unchanged")).toBe(true);
    expect(rest.writes).toHaveLength(count);
  });

  test("creates only missing named objects and retains unrelated objects", async () => {
    const rest = new FakeRest();
    const input = manifest();
    input.clients[0]!.clientId = "new-web";
    input.clientScopes[0]!.name = "new-scope";
    input.realmRoles[0]!.name = "new-role";
    expect((await run(input, rest)).applied).toBe(4);
    expect(rest.clients).toHaveLength(3);
    expect(rest.scopes).toHaveLength(3);
    expect(rest.roles).toHaveLength(3);
    expect((await run(input, rest)).applied).toBe(0);
  });

  test.each(["users", "groups", "organizations", "memberships", "components", "smtpServer", "partialImport", "secret"])(
    "rejects forbidden root %s before any REST call", async (key) => {
      const rest = new FakeRest();
      await expect(run({ ...manifest(), [key]: [] }, rest)).rejects.toThrow("INVALID_MANIFEST");
      expect(rest.calls).toHaveLength(0);
    },
  );

  test("validates the final entry before any write including bootstrap", async () => {
    const rest = new FakeRest(); rest.realm = undefined;
    const input = manifest();
    input.clients.push({ clientId: "last", secret: "synthetic-secret" } as never);
    await expect(run(input, rest, "apply", true)).rejects.toThrow("INVALID_MANIFEST");
    expect(rest.calls).toHaveLength(0);
  });

  test.each([
    { version: 2 }, { realm: "master" }, { realm: "MASTER" }, { realm: "../master" },
    { settings: { smtpServer: {} } }, { settings: { accessTokenLifespan: -1 } },
    { settings: { enabled: "true" } }, { clients: [{ clientId: "a", id: "forced-id" }] },
    { clients: [{ clientId: "a" }, { clientId: "a" }] },
    { clients: [{ clientId: "a", attributes: { secret: "synthetic" } }] },
    { clients: [{ clientId: "a", redirectUris: ["https://app.example.test/cb?token=synthetic"] }] },
    { clients: [{ clientId: "a", redirectUris: ["https://user:synthetic@app.example.test"] }] },
    { clients: [{ clientId: "a", publicClient: true, serviceAccountsEnabled: true }] },
    { clientScopes: [{ name: "a", protocolMappers: [] }] }, { realmRoles: [{ name: "a", composites: {} }] },
  ])("rejects malformed, unbounded or credential-bearing config %#", async (patch) => {
    const rest = new FakeRest();
    await expect(run({ ...manifest(), ...patch }, rest)).rejects.toBeInstanceOf(RealmReconcileError);
    expect(rest.calls).toHaveLength(0);
  });

  test.each(["mcp-resource:example", "organization:sample:role:reader", "org:sample", "dcr-client", "00000000-0000-4000-8000-000000000001"])(
    "rejects runtime namespace %s across all object collections", async (reserved) => {
      for (const [key, entry] of [["clients", { clientId: reserved }], ["clientScopes", { name: reserved }], ["realmRoles", { name: reserved }]]) {
        const rest = new FakeRest();
        await expect(run({ ...manifest(), [key as string]: [entry] }, rest)).rejects.toThrow("RUNTIME_NAMESPACE_FORBIDDEN");
        expect(rest.calls).toHaveLength(0);
      }
    },
  );

  test("rejects independent target mismatch without REST", async () => {
    const rest = new FakeRest();
    await expect(reconcileKeycloakRealm(manifest(), rest, { expectedRealm: "another", mode: "apply" })).rejects.toThrow("REALM_MISMATCH");
    expect(rest.calls).toHaveLength(0);
  });

  test("rejects wrong realm returned by adapter", async () => {
    const rest = new FakeRest(); rest.realm!.realm = "master";
    await expect(run(manifest(), rest)).rejects.toThrow("REALM_MISMATCH");
    expect(rest.writes).toHaveLength(0);
  });

  test("missing realm requires explicit bootstrap; plan does not create", async () => {
    const rest = new FakeRest(); rest.realm = undefined;
    await expect(run(manifest(), rest)).rejects.toThrow("REALM_MISSING_BOOTSTRAP_REQUIRED");
    expect((await run(manifest(), rest, "plan", true)).changes[0]?.action).toBe("create");
    expect(rest.writes).toHaveLength(0);
    expect((await run(manifest(), rest, "apply", true)).applied).toBe(5);
    expect(rest.writes[0]).toEqual({ method: "POST", path: "/admin/realms", body: { realm: "example" } });
    expect((await run(manifest(), rest)).applied).toBe(0);
  });

  test.each([401, 403, 500])("HTTP %s never triggers bootstrap", async (status) => {
    const rest = new FakeRest(); rest.intercept = () => ({ status, body: "synthetic-secret" });
    await expect(run(manifest(), rest, "apply", true)).rejects.toThrow("REST_REQUEST_FAILED");
    expect(rest.writes).toHaveLength(0);
  });

  test("a late preflight failure leaves every object unchanged", async () => {
    const rest = new FakeRest();
    rest.clients.push({ id: "duplicate", clientId: "web" });
    await expect(run(manifest(), rest)).rejects.toThrow("AMBIGUOUS_MANAGED_OBJECT");
    expect(rest.writes).toHaveLength(0);
  });

  test("an existing DCR registration cannot be adopted by a friendly client name", async () => {
    const rest = new FakeRest(); rest.clients[0]!.registrationAccessToken = "synthetic-token";
    await expect(run(manifest(), rest)).rejects.toThrow("DYNAMIC_CLIENT_COLLISION");
    expect(rest.writes).toHaveLength(0);
  });

  test("detects realm replacement before writing", async () => {
    const rest = new FakeRest(); let reads = 0;
    rest.intercept = (request) => request.path === root && request.method === "GET" && ++reads > 1
      ? { status: 200, body: { realm: "example", id: "replacement" } } : undefined;
    await expect(run(manifest(), rest)).rejects.toThrow("REALM_MISMATCH");
    expect(rest.writes).toHaveLength(0);
  });

  test("failed apply reports sanitized partial progress and is retryable", async () => {
    const rest = new FakeRest();
    rest.intercept = (request) => { if (request.method === "PUT" && request.path.includes("client-scopes")) throw new Error("synthetic-secret"); };
    let failure: RealmReconcileError | undefined;
    try { await run(manifest(), rest); } catch (error) { failure = error as RealmReconcileError; }
    expect(failure?.code).toBe("REST_TRANSPORT_FAILED");
    expect(failure?.report?.applied).toBe(1);
    expect(JSON.stringify(failure)).not.toContain("synthetic-secret");
    rest.intercept = undefined;
    expect((await run(manifest(), rest)).applied).toBe(3);
    expect((await run(manifest(), rest)).applied).toBe(0);
  });

  test("array ordering and omitted fields do not cause writes", async () => {
    const rest = new FakeRest();
    rest.clients[0]!.redirectUris = ["https://b.example.test/cb", "https://a.example.test/cb"];
    const input = manifest(); input.settings = {}; input.clientScopes = []; input.realmRoles = [];
    input.clients = [{ clientId: "web", redirectUris: ["https://a.example.test/cb", "https://b.example.test/cb"] }];
    expect((await run(input, rest)).applied).toBe(0);
  });

  test("validated manifest is a snapshot and prototype keys fail closed", () => {
    const input = manifest(); const snapshot = validateRealmManifest(input);
    input.clients[0]!.clientId = "changed";
    expect(snapshot.clients[0]!.clientId).toBe("web");
    expect(() => validateRealmManifest(JSON.parse(JSON.stringify(manifest()).replace('"settings":{', '"settings":{"__proto__":{},')))).toThrow("INVALID_MANIFEST");
  });
});
