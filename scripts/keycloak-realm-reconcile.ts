// SPDX-License-Identifier: BUSL-1.1

/** Git-owned, additive Keycloak Admin REST reconciliation; no runtime provisioning.
 * The caller supplies an authenticated adapter pinned to one trusted server and
 * serializes deployments (Keycloak offers no conditional PUT here). Never log
 * adapter bodies/errors: they may contain credentials. No network or CLI on import.
 * Only supplied fields are owned. Omission never deletes an object or clears a
 * field. Explicit arrays replace that field; array ordering is insignificant.
 * Scope assignments, mappers, composites, secrets and runtime identities are
 * intentionally outside v1. Names in the manifest explicitly adopt existing objects.
 * REST contract: https://www.keycloak.org/docs-api/latest/rest-api/index.html
 */
export interface RealmSettings {
  enabled?: boolean;
  registrationAllowed?: boolean;
  registrationEmailAsUsername?: boolean;
  rememberMe?: boolean;
  verifyEmail?: boolean;
  resetPasswordAllowed?: boolean;
  loginWithEmailAllowed?: boolean;
  duplicateEmailsAllowed?: boolean;
  bruteForceProtected?: boolean;
  organizationsEnabled?: boolean;
  sslRequired?: "all" | "external" | "none";
  accessTokenLifespan?: number;
  ssoSessionIdleTimeout?: number;
  ssoSessionMaxLifespan?: number;
}

export interface ManagedClient {
  clientId: string;
  name?: string;
  description?: string;
  protocol?: "openid-connect";
  enabled?: boolean;
  publicClient?: boolean;
  standardFlowEnabled?: boolean;
  implicitFlowEnabled?: boolean;
  directAccessGrantsEnabled?: boolean;
  serviceAccountsEnabled?: boolean;
  fullScopeAllowed?: boolean;
  consentRequired?: boolean;
  redirectUris?: string[];
  webOrigins?: string[];
}

export interface ManagedClientScope {
  name: string;
  description?: string;
  protocol?: "openid-connect";
}

export interface ManagedRealmRole { name: string; description?: string }

export interface RealmManifest {
  version: 1;
  realm: string;
  settings: RealmSettings;
  clients: ManagedClient[];
  clientScopes: ManagedClientScope[];
  realmRoles: ManagedRealmRole[];
}

export interface RestRequest {
  method: "GET" | "POST" | "PUT";
  /** Absolute path relative to the trusted server, never an arbitrary URL. */
  path: string;
  body?: Record<string, unknown>;
}
export interface RestResponse { status: number; body?: unknown }
export interface KeycloakRestAdapter {
  request(request: RestRequest): Promise<RestResponse>;
}
export interface ReconcileOptions {
  /** Independently configured deployment target, not derived from the manifest. */
  expectedRealm: string;
  mode: "plan" | "apply";
  /** Deployment/bootstrap authority only. Never enable from runtime provisioning. */
  bootstrapMissingRealm?: boolean;
}
export interface PlannedChange {
  kind: "realm" | "client" | "clientScope" | "realmRole";
  name: string;
  action: "create" | "update" | "unchanged";
  fields: string[];
}
export interface ReconcileReport {
  mode: "plan" | "apply";
  changes: PlannedChange[];
  applied: number;
}

/** Contains only sanitized progress; there is deliberately no raw error cause. */
export class RealmReconcileError extends Error {
  constructor(public readonly code: string, public readonly report?: ReconcileReport) {
    super(code);
    this.name = "RealmReconcileError";
  }
}

type ObjectValue = Record<string, unknown>;
type Check = (value: unknown) => boolean;
const bool: Check = (value) => typeof value === "boolean";
const text: Check = (value) => typeof value === "string" && value.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(value);
const name: Check = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const realmName: Check = (value) => name(value) && !String(value).includes(":") && String(value).toLowerCase() !== "master";
const runtimeName = (value: string) => /^(?:mcp-resource:|organization:|org:|dcr[:_-])/i.test(value) ||
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const duration: Check = (value) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 2_147_483_647;
const protocol: Check = (value) => value === "openid-connect";
const uri: Check = (value) => {
  if (!text(value)) return false;
  try {
    const url = new URL(value as string);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
};
const uris: Check = (value) => Array.isArray(value) && value.length <= 100 && value.every(uri) && new Set(value).size === value.length;
const origins: Check = (value) => uris(value) && (value as string[]).every((item) => new URL(item).origin === item);

const settingsSchema: Record<keyof RealmSettings, Check> = {
  enabled: bool, registrationAllowed: bool, registrationEmailAsUsername: bool,
  rememberMe: bool, verifyEmail: bool, resetPasswordAllowed: bool,
  loginWithEmailAllowed: bool, duplicateEmailsAllowed: bool, bruteForceProtected: bool,
  organizationsEnabled: bool,
  sslRequired: (value) => ["all", "external", "none"].includes(value as string),
  accessTokenLifespan: duration, ssoSessionIdleTimeout: duration, ssoSessionMaxLifespan: duration,
};
const clientSchema: Record<keyof ManagedClient, Check> = {
  clientId: name, name: text, description: text, protocol, enabled: bool,
  publicClient: bool, standardFlowEnabled: bool, implicitFlowEnabled: bool,
  directAccessGrantsEnabled: bool, serviceAccountsEnabled: bool, fullScopeAllowed: bool,
  consentRequired: bool, redirectUris: uris, webOrigins: origins,
};
const scopeSchema: Record<keyof ManagedClientScope, Check> = { name, description: text, protocol };
const roleSchema: Record<keyof ManagedRealmRole, Check> = { name, description: text };

function fail(code: string): never { throw new RealmReconcileError(code); }
function object(value: unknown, code = "INVALID_MANIFEST"): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  return value as ObjectValue;
}
function validateFields(value: unknown, schema: Record<string, Check>, required: string[] = []): ObjectValue {
  const result = object(value);
  for (const key of Reflect.ownKeys(result)) {
    if (typeof key !== "string" || !Object.hasOwn(schema, key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(result, key)!, "value") || !schema[key]!(result[key])) {
      fail("INVALID_MANIFEST");
    }
  }
  if (required.some((key) => !Object.hasOwn(result, key))) fail("INVALID_MANIFEST");
  return result;
}
function collection(value: unknown, schema: Record<string, Check>, identity: string): boolean {
  if (!Array.isArray(value) || value.length > 1000) return false;
  const names = new Set<unknown>();
  for (const item of value) {
    const entry = validateFields(item, schema, [identity]);
    if (runtimeName(entry[identity] as string)) fail("RUNTIME_NAMESPACE_FORBIDDEN");
    if (names.has(entry[identity])) return false;
    names.add(entry[identity]);
    if (entry.publicClient === true && entry.serviceAccountsEnabled === true) return false;
  }
  return true;
}

/** Validate and snapshot before any asynchronous work or REST calls. */
export function validateRealmManifest(input: unknown): RealmManifest {
  validateFields(input, {
    version: (value) => value === 1, realm: realmName,
    settings: (value) => { validateFields(value, settingsSchema); return true; },
    clients: (value) => collection(value, clientSchema, "clientId"),
    clientScopes: (value) => collection(value, scopeSchema, "name"),
    realmRoles: (value) => collection(value, roleSchema, "name"),
  }, ["version", "realm", "settings", "clients", "clientScopes", "realmRoles"]);
  return structuredClone(input) as RealmManifest;
}

function equal(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  return a === b;
}
function serverObject(value: unknown): ObjectValue { return object(value, "INVALID_SERVER_RESPONSE"); }
function serverId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail("INVALID_SERVER_RESPONSE");
  return value as string;
}
interface Operation { change: PlannedChange; request?: RestRequest }

/** Replans on every call; never accepts a stale or caller-modified plan to apply.
 * Reads all managed objects before writing. Apply is sequential, not transactional:
 * on failure inspect error.report.applied and rerun after resolving the cause.
 * A failed transport can have committed a write; a rerun resolves that ambiguity.
 */
export async function reconcileKeycloakRealm(
  input: unknown, adapter: KeycloakRestAdapter, options: ReconcileOptions,
): Promise<ReconcileReport> {
  const manifest = validateRealmManifest(input);
  const { expectedRealm, mode, bootstrapMissingRealm = false } = options;
  if (!realmName(expectedRealm) || expectedRealm !== manifest.realm) fail("REALM_MISMATCH");
  if (!["plan", "apply"].includes(mode) || typeof bootstrapMissingRealm !== "boolean") fail("INVALID_OPTIONS");
  const report: ReconcileReport = { mode, changes: [], applied: 0 };
  const root = `/admin/realms/${encodeURIComponent(expectedRealm)}`;
  const call = async (request: RestRequest, allowMissing = false): Promise<RestResponse> => {
    let response: RestResponse;
    try { response = await adapter.request(request); } catch { fail("REST_TRANSPORT_FAILED"); }
    const expected = request.method === "GET" ? 200 : request.method === "POST" ? 201 : 204;
    if (!response || (response.status !== expected && !(allowMissing && response.status === 404))) fail("REST_REQUEST_FAILED");
    return response;
  };
  const get = async (path: string) => (await call({ method: "GET", path })).body;
  const operations: Operation[] = [];
  const add = (kind: PlannedChange["kind"], identity: string, desired: ObjectValue, current: ObjectValue | undefined, createPath: string, updatePath: string) => {
    const fields = Object.keys(desired).filter((key) => !current || !equal(desired[key], current[key])).sort();
    const action = !current ? "create" : fields.length ? "update" : "unchanged";
    const change: PlannedChange = { kind, name: identity, action, fields };
    operations.push({ change, ...(action === "unchanged" ? {} : { request: {
      method: action === "create" ? "POST" as const : "PUT" as const,
      path: action === "create" ? createPath : updatePath,
      // Send only explicit owned fields, never echo secrets or nested server state.
      body: { ...desired },
    } }) });
  };
  try {
    let realmResponse = await call({ method: "GET", path: root }, true);
    let missing = realmResponse.status === 404;
    if (missing) {
      if (!bootstrapMissingRealm) fail("REALM_MISSING_BOOTSTRAP_REQUIRED");
      report.changes.push({ kind: "realm", name: expectedRealm, action: "create", fields: ["realm"] });
      if (mode === "apply") {
        await call({ method: "POST", path: "/admin/realms", body: { realm: expectedRealm } });
        report.applied++;
        // Bootstrap creates server defaults; inspect them before adopting any names.
        realmResponse = await call({ method: "GET", path: root });
        missing = false;
      }
    }
    const realm = missing ? undefined : serverObject(realmResponse.body);
    if (realm && realm.realm !== expectedRealm) fail("REALM_MISMATCH");
    const realmId = realm ? serverId(realm.id) : undefined;
    add("realm", expectedRealm, { ...manifest.settings }, realm ?? {}, root, root);

    let scopes: ObjectValue[] = [];
    if (!missing && manifest.clientScopes.length) {
      const response = await get(`${root}/client-scopes`);
      if (!Array.isArray(response)) fail("INVALID_SERVER_RESPONSE");
      scopes = response.map(serverObject);
    }
    for (const desired of manifest.clientScopes) {
      const matches = scopes.filter((item) => item.name === desired.name);
      if (matches.length > 1) fail("AMBIGUOUS_MANAGED_OBJECT");
      let current = matches[0];
      const path = current ? `${root}/client-scopes/${serverId(current.id)}` : "";
      if (current) {
        const id = current.id;
        current = serverObject(await get(path));
        if (current.id !== id || current.name !== desired.name) fail("OBJECT_IDENTITY_MISMATCH");
      }
      add("clientScope", desired.name, { ...desired }, current, `${root}/client-scopes`, path);
    }
    for (const desired of manifest.realmRoles) {
      const path = `${root}/roles/${encodeURIComponent(desired.name)}`;
      const response = missing ? undefined : await call({ method: "GET", path }, true);
      const current = !response || response.status === 404 ? undefined : serverObject(response.body);
      if (current) {
        serverId(current.id);
        if (current.name !== desired.name || current.clientRole !== false) fail("OBJECT_IDENTITY_MISMATCH");
      }
      add("realmRole", desired.name, { ...desired }, current, `${root}/roles`, path);
    }
    for (const desired of manifest.clients) {
      const response = missing ? [] : await get(`${root}/clients?clientId=${encodeURIComponent(desired.clientId)}&first=0&max=2`);
      if (!Array.isArray(response)) fail("INVALID_SERVER_RESPONSE");
      const matches = response.map(serverObject);
      // The clientId query is exact. Unexpected rows or truncation fail closed.
      if (matches.length > 1) fail("AMBIGUOUS_MANAGED_OBJECT");
      let current = matches[0];
      const path = current ? `${root}/clients/${serverId(current.id)}` : "";
      if (current) {
        if (current.clientId !== desired.clientId) fail("OBJECT_IDENTITY_MISMATCH");
        const id = current.id;
        current = serverObject(await get(path));
        if (current.id !== id || current.clientId !== desired.clientId) fail("OBJECT_IDENTITY_MISMATCH");
        if (current.registrationAccessToken) fail("DYNAMIC_CLIENT_COLLISION");
      }
      if ((desired.publicClient ?? current?.publicClient) === true &&
          (desired.serviceAccountsEnabled ?? current?.serviceAccountsEnabled) === true) fail("INVALID_CLIENT_CONFIGURATION");
      if (current?.protocol && desired.protocol && current.protocol !== desired.protocol) fail("PROTOCOL_CHANGE_UNSUPPORTED");
      add("client", desired.clientId, { ...desired }, current, `${root}/clients`, path);
    }
    report.changes.push(...operations.map((operation) => operation.change));
    if (mode === "apply") {
      for (const operation of operations) {
        if (!operation.request) continue;
        const liveRealm = serverObject(await get(root));
        if (liveRealm.realm !== expectedRealm || liveRealm.id !== realmId) fail("REALM_MISMATCH");
        await call(operation.request);
        report.applied++;
      }
    }
    return report;
  } catch (error) {
    throw new RealmReconcileError(error instanceof RealmReconcileError ? error.code : "RECONCILIATION_FAILED", report);
  }
}
