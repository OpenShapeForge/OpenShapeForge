// SPDX-License-Identifier: BUSL-1.1
/**
 * The compiled connector catalog, as the runtime sees it.
 *
 * Loaded once at module load from the generated artifact, exactly as the MCP
 * tool catalog and the OpenAPI spec are. The artifact is always emitted — with
 * an empty `connectors` array when none are authored — so this import never
 * needs guarding.
 *
 * Nothing here reaches a database or resolves an implementation package: this
 * is the static half of a connector, identical for every tenant. Per-tenant
 * state (installations, secrets, entitlement grants) lives in `store.ts`.
 */
import catalog from "../generated/connectors/catalog.json" with { type: "json" };

export type ConnectorOperationContract = {
  key: string;
  kind: "query" | "mutation";
  label?: Record<string, string>;
  description?: string | Record<string, string>;
  graphql: { field: string; inputType: string; resultType: string };
  rest: { method: "GET" | "POST"; path: string };
  mcp?: { toolName: string };
  roles: { invoke: string[] };
  schemas: { input: Record<string, unknown>; output: Record<string, unknown> };
  reliability: {
    timeouts: { attemptMs: number; totalMs: number };
    retry: { eligible: boolean; maxAttempts: number; backoff: string };
    idempotency?: { strategy: string; keyInput?: string; header?: string };
    concurrency: { perTenant: number };
    // Both optional in the compiled contract, and both were missing here: this
    // type is a hand-maintained mirror of the emitted JSON, so a field the
    // compiler emits but nobody declares is invisible to every consumer rather
    // than a type error.
    rateLimit?: { perTenantPerMinute: number };
    circuitBreaker?: { failureThreshold: number; resetAfterMs: number };
    limits: { requestBytes: number; responseBytes: number };
    pagination: { style: string };
  };
};

export type ConnectorContract = {
  slug: string;
  connector: string;
  title: string;
  labels?: Record<string, string>;
  description?: string | Record<string, string>;
  category?: string;
  domains: string[];
  capabilities: string[];
  implementation: {
    package: string;
    contractVersion: number;
    provenance: "firstParty" | "reviewed" | "thirdParty";
    license: { spdx: string; url?: string; notice?: string };
  };
  availability: { entitlement?: string };
  configuration: {
    instances: "single" | "multiple";
    verify: boolean;
    fields: { key: string; secret?: boolean; required?: boolean }[];
    secretFields: string[];
    schema: Record<string, unknown>;
  };
  /**
   * OAuth 2.0, when the contract declares it. Absent means the package
   * authenticates from its own configuration fields.
   *
   * The platform owns the token lifecycle behind this — see `oauth.ts`. A
   * package is handed a fetch already carrying the access token and never sees
   * a refresh token, which is what lets a provider that rotates single-use
   * refresh tokens work at all.
   */
  auth?: {
    type: "oauth2";
    /** `clientCredentials` has no consent screen, no callback and no refresh token. */
    flow: "authorizationCode" | "clientCredentials";
    /** May interpolate `{fieldKey}` from non-secret configuration. Authorization code only. */
    authorizeUrl?: string;
    tokenUrl: string;
    scopes: string[];
    clientIdField: string;
    clientSecretField: string;
    refreshLeewaySeconds: number;
  };
  network: { egress: string[] };
  operations: ConnectorOperationContract[];
  exposure: {
    graphql: boolean;
    rest?: { basePath: string };
    mcp?: { toolPrefix: string };
  };
  namespace: string;
  checksum: string;
};

export type ConnectorCatalog = {
  version: number;
  checksum: string;
  connectors: ConnectorContract[];
};

export const connectorCatalog = catalog as unknown as ConnectorCatalog;

const bySlug = new Map(
  connectorCatalog.connectors.map((contract) => [contract.slug, contract]),
);

export function listConnectorContracts(): ConnectorContract[] {
  return connectorCatalog.connectors;
}

export function findConnectorContract(slug: string): ConnectorContract | undefined {
  return bySlug.get(slug);
}

/** Config fields whose absence should block enabling an installation. */
export function requiredSecretFields(contract: ConnectorContract): string[] {
  return contract.configuration.fields
    .filter((field) => field.secret === true && field.required === true)
    .map((field) => field.key)
    .sort();
}
