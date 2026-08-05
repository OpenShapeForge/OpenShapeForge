// SPDX-License-Identifier: BUSL-1.1
/**
 * Connector authoring and compiled types.
 *
 * A connector is a fourth authoring artifact type alongside entities, workflow
 * nodes and catalogs. It declares an INTERFACE — what a connector can do and
 * how the platform exposes it — while the implementation ships as a separate
 * package under its own license.
 *
 * Contract-first, implementation-optional: the compiler never resolves the
 * implementation package (that would make output depend on node_modules and
 * break the determinism gates), so a contract compiles identically on a machine
 * that has none of the packages installed. Availability is resolved at runtime.
 *
 * Capabilities are typed and opt-in. An infrastructure connector that only
 * delivers events must not acquire a GraphQL namespace, so surfaces are
 * projected per capability rather than for every connector.
 */
import type { FieldV2 } from "./field-v2.js";
import type { LocalizedText } from "./common.js";

// ---------------------------------------------------------------------------
// Authoring shape (what a connectors/<slug>.yaml file may contain)
// ---------------------------------------------------------------------------

/**
 * What a connector does, declared explicitly so surfaces follow from the
 * capability rather than from the mere existence of a connector.
 *
 * `operations` is the only capability implemented today. `eventSource` and
 * `eventSink` are reserved: the platform-owned event pipeline (canonical
 * envelope, outbox boundary, retry scheduling, dead-letter, replay) is designed
 * separately, and a connector claiming them today would advertise transport
 * guarantees nothing enforces. The compiler therefore REJECTS them rather than
 * accepting them silently.
 */
export type ConnectorCapabilityKey = "operations" | "eventSource" | "eventSink";

/**
 * Who wrote the implementation package, which bounds how the platform may
 * execute it. Recorded on the contract so the execution trust model can be
 * enforced once it is settled: a deployment that only permits in-process
 * execution of reviewed code can refuse `thirdParty` without re-authoring
 * anything.
 */
export type ConnectorProvenance = "firstParty" | "reviewed" | "thirdParty";

export interface ConnectorImplementation {
  /**
   * Module specifier of the implementation package, recorded VERBATIM. Never
   * resolved at compile time — see the file header.
   */
  package: string;
  /** Runtime contract generation the package implements. */
  contractVersion: number;
  provenance: ConnectorProvenance;
  license: {
    /** SPDX identifier or `LicenseRef-*` for a bespoke commercial license. */
    spdx: string;
    url?: string;
    /** Shown wherever the connector is offered; metadata, not enforcement. */
    notice?: string;
  };
}

export interface ConnectorAvailability {
  /**
   * Entitlement key that must be granted before this connector may be
   * installed or invoked. Absent means always available (a first-party or
   * openly licensed connector). The grant itself lives in a signed deployment
   * license verified at runtime — never in this file.
   */
  entitlement?: string;
}

export interface ConnectorConfiguration {
  /** Whether a tenant may configure one instance or several. */
  instances?: "single" | "multiple";
  /** The package exposes verify(); the product offers a "test connection". */
  verify?: boolean;
  /**
   * The configuration interface, in the same field vocabulary workflow nodes
   * use for their node config. A generic form renders from this — there is no
   * per-connector configuration UI.
   */
  fields: ConnectorConfigField[];
}

/**
 * OAuth 2.0, declared by the contract and driven by the PLATFORM.
 *
 * The division is the point. A contract says where the provider's endpoints are
 * and which flow it speaks; the platform obtains, stores, refreshes and rotates
 * the tokens, and a package never receives one — it is handed a `fetch` that
 * already carries the access token. So a connector cannot mishandle a refresh
 * token it never sees, and rotation is solved once rather than once per
 * connector.
 *
 * That matters because rotation is not optional for some providers. Exact
 * Online issues a single-use refresh token and replaces it on every refresh: a
 * connector that failed to persist the replacement would authenticate once and
 * break on its next call.
 *
 * CLIENT CREDENTIALS ARE NOT DECLARED HERE. Each tenant registers its own
 * application with the provider, so the client id and secret are ordinary
 * configuration fields on the installation — named below rather than assumed,
 * because nothing makes "clientId" a universal spelling.
 */
export interface ConnectorOAuth {
  type: "oauth2";
  /**
   * Who the token represents.
   *
   * `authorizationCode` acts on behalf of a PERSON: a consent screen, a
   * callback, and a refresh token to keep the grant alive. `clientCredentials`
   * acts as the APPLICATION itself — no consent, no callback, and no refresh
   * token, because an expired access token is simply requested again with the
   * same client credentials.
   */
  flow: "authorizationCode" | "clientCredentials";
  /**
   * Endpoints, which may interpolate `{fieldKey}` from NON-SECRET
   * configuration.
   *
   * Templated rather than literal because a provider's endpoint is frequently
   * per-tenant: Exact Online runs a separate instance per country
   * (`start.exactonline.nl`, `.be`, `.de`), and AFAS a separate host per
   * environment. A literal URL would mean one contract per region — a copy of
   * the same connector whose only difference is a hostname.
   */
  /** Authorization code only; declaring it for client credentials is refused. */
  authorizeUrl?: string;
  tokenUrl: string;
  /**
   * Required for `clientCredentials`, which has no other way to say which
   * resource the token is for — Entra wants `{resource}/.default`. Optional for
   * authorization code, where a provider may take none.
   */
  scopes?: string[];
  /** Configuration field holding the client id issued by the provider. */
  clientIdField: string;
  /** Configuration field holding the client secret. Must be `secret: true`. */
  clientSecretField: string;
  /**
   * Seconds of headroom before expiry at which the platform refreshes anyway.
   * A token that is valid when checked and expired when it arrives is a race
   * nobody can see in a log.
   */
  refreshLeewaySeconds?: number;
}

/**
 * A configuration field. `secret: true` is the only addition over the shared
 * field vocabulary: it routes the value to encrypted storage, keeps it out of
 * every read path, and marks it for redaction in logs and errors.
 */
export type ConnectorConfigField = FieldV2 & { secret?: boolean };

export interface ConnectorNetwork {
  /**
   * Hostnames (wildcards allowed at the leftmost label) the connector may
   * reach. Enforced by the runtime's bound fetch. Omitted means no outbound
   * HTTP at all — the allowlist is the grant, not a filter over an open door.
   */
  egress?: string[];
}

export type ConnectorOperationKind = "query" | "mutation";

/**
 * How duplicate side effects are prevented when an operation is retried.
 *
 * `natural` asserts the upstream operation is inherently idempotent (a PUT to a
 * stable path, a lookup). `key` names an input field carrying an idempotency
 * key the connector forwards upstream.
 */
export interface ConnectorIdempotency {
  strategy: "natural" | "key";
  /** Required for `key`: the input field key holding the idempotency key. */
  keyInput?: string;
  /**
   * Header the key travels in. Defaults to `Idempotency-Key`, the name in the
   * IETF HTTPAPI draft that Stripe and PayPal's implementations informed —
   * aligning with it means an upstream that already speaks the convention
   * needs no per-connector special casing.
   *
   * The draft's rule carries over to us: a key MUST NOT be reused with a
   * different payload. A connector that derives its key from a mutable field
   * violates that, which is why `keyInput` must name a real input field.
   */
  header?: string;
}

/**
 * Timeouts, split the way workflow engines split them (Temporal's
 * start-to-close vs schedule-to-close), because one number cannot express both.
 *
 * `attemptMs` bounds a single attempt. `totalMs` bounds the whole operation
 * INCLUDING retries — without it, three attempts at a 30s budget can occupy 90
 * seconds while every individual attempt looks well-behaved, and the caller
 * that set "30 seconds" has no way to say what it actually meant.
 */
export interface ConnectorTimeouts {
  attemptMs?: number;
  totalMs?: number;
}

/**
 * Operating policy for reaching a remote system. Everything here has a platform
 * default; authoring only overrides. `kind` alone is not enough to run remote
 * calls safely, so these are part of the contract rather than runtime tuning.
 */
export interface ConnectorReliability {
  /** Attempt and overall budgets; see ConnectorTimeouts. */
  timeouts?: ConnectorTimeouts;
  retry?: {
    /**
     * A mutation may only be retry-eligible when `idempotency` is declared —
     * enforced at compile time, because an automatic retry of a non-idempotent
     * remote mutation duplicates real-world side effects.
     */
    eligible: boolean;
    maxAttempts?: number;
    backoff?: "exponential" | "fixed";
  };
  idempotency?: ConnectorIdempotency;
  concurrency?: { perTenant?: number };
  rateLimit?: { perTenantPerMinute?: number };
  circuitBreaker?: { failureThreshold?: number; resetAfterMs?: number };
  limits?: { requestBytes?: number; responseBytes?: number };
  /** How the upstream paginates, so the platform can page uniformly. */
  pagination?: { style: "cursor" | "page" | "none" };
}

export interface ConnectorOperationOutput {
  cardinality: "one" | "many";
  fields: FieldV2[];
}

export interface ConnectorOperation {
  key: string;
  kind: ConnectorOperationKind;
  label?: LocalizedText;
  description?: string | LocalizedText;
  /** Per-operation role allow-list, enforced before the package is called. */
  authorization?: { roles: { invoke: string[] } };
  input?: FieldV2[];
  output: ConnectorOperationOutput;
  reliability?: ConnectorReliability;
  /** REST overrides; both default from the operation key and kind. */
  rest?: { method?: "GET" | "POST"; path?: string };
}

export type ConnectorEventDirection = "inbound" | "outbound";

export interface ConnectorEvent {
  key: string;
  direction: ConnectorEventDirection;
  label?: LocalizedText;
  payload: FieldV2[];
}

export interface ConnectorRestExposure {
  enabled?: boolean;
  /**
   * Path segment under the fixed `connectors/` mount. Because every connector
   * route lives under that segment, a connector can never collide with an
   * entity's REST base path.
   */
  basePath?: string;
}

/**
 * MCP exposure mirrors the per-entity `mcp:` block: same opt-in shape, same
 * tool-prefix constraint, same dedicated/generic trade-off, and connector tools
 * count against the same catalog budget. Connector operations differ from CRUD
 * in one way that matters — each carries its own input and output schema — so
 * they are dispatched separately, not folded into the entity tools.
 */
export interface ConnectorMcpExposure {
  enabled?: boolean;
  toolPrefix?: string;
  /** Per-operation flags keyed by operation key; each defaults to true. */
  operations?: Record<string, boolean>;
}

export interface ConnectorExposure {
  graphql?: boolean;
  rest?: boolean | ConnectorRestExposure;
  mcp?: boolean | ConnectorMcpExposure;
}

export interface ConnectorDefinition {
  schemaVersion: number;
  kind: "connector";
  /** PascalCase; becomes the GraphQL namespace type and type-name prefix. */
  connector: string;
  title: string;
  labels?: LocalizedText;
  description?: string | LocalizedText;
  category?: string;
  domains?: string[];
  capabilities: ConnectorCapabilityKey[];
  implementation: ConnectorImplementation;
  availability?: ConnectorAvailability;
  configuration?: ConnectorConfiguration;
  /** Absent means the package authenticates from its own config fields. */
  auth?: ConnectorOAuth;
  network?: ConnectorNetwork;
  operations?: ConnectorOperation[];
  events?: ConnectorEvent[];
  exposure?: ConnectorExposure;
}

// ---------------------------------------------------------------------------
// Compiled shape (normalized; what generators and the runtime consume)
// ---------------------------------------------------------------------------

export interface CompiledConnectorReliability {
  timeouts: { attemptMs: number; totalMs: number };
  retry: { eligible: boolean; maxAttempts: number; backoff: "exponential" | "fixed" };
  idempotency?: ConnectorIdempotency;
  concurrency: { perTenant: number };
  rateLimit?: { perTenantPerMinute: number };
  circuitBreaker?: { failureThreshold: number; resetAfterMs: number };
  limits: { requestBytes: number; responseBytes: number };
  pagination: { style: "cursor" | "page" | "none" };
}

export interface CompiledConnectorOperation {
  key: string;
  kind: ConnectorOperationKind;
  label?: LocalizedText;
  description?: string | LocalizedText;
  /** GraphQL field name (the operation key) and its generated type names. */
  graphql: { field: string; inputType: string; resultType: string };
  rest: { method: "GET" | "POST"; path: string };
  /** Present only when the connector exposes MCP and the operation is enabled. */
  mcp?: { toolName: string };
  roles: { invoke: string[] };
  input: FieldV2[];
  output: ConnectorOperationOutput;
  /**
   * The runtime boundary with the implementation package: input is validated
   * before the package is called, output before anything reaches a caller.
   * Generated TypeScript types are erased before a package is ever loaded, so
   * they cannot serve this purpose. Shared with the MCP catalog's constraint
   * mapping so the two surfaces cannot disagree about what an operation accepts.
   */
  schemas: { input: Record<string, unknown>; output: Record<string, unknown> };
  reliability: CompiledConnectorReliability;
}

export interface CompiledConnectorExposure {
  graphql: boolean;
  rest?: { basePath: string };
  mcp?: { toolPrefix: string };
}

export interface CompiledConnectorContract {
  slug: string;
  connector: string;
  title: string;
  labels?: LocalizedText;
  description?: string | LocalizedText;
  category?: string;
  domains: string[];
  capabilities: ConnectorCapabilityKey[];
  implementation: ConnectorImplementation;
  availability: { entitlement?: string };
  configuration: {
    instances: "single" | "multiple";
    verify: boolean;
    fields: ConnectorConfigField[];
    /** Config field keys marked secret, precomputed for storage and redaction. */
    secretFields: string[];
    /**
     * JSON Schema for a submitted configuration, generated from the same field
     * vocabulary as the operation schemas. The API validates against this
     * rather than walking the field list itself, so what the configuration form
     * is rendered from and what the write path enforces cannot diverge.
     */
    schema: Record<string, unknown>;
  };
  /** Normalized with defaults applied; absent when the contract declares none. */
  auth?: Required<
    Pick<
      ConnectorOAuth,
      "type" | "flow" | "tokenUrl" | "clientIdField" | "clientSecretField" | "refreshLeewaySeconds"
    >
  > & {
    scopes: string[];
    /** Present for `authorizationCode` only. */
    authorizeUrl?: string;
  };
  network: { egress: string[] };
  operations: CompiledConnectorOperation[];
  events: ConnectorEvent[];
  exposure: CompiledConnectorExposure;
  /** GraphQL namespace field on Query/Mutation (the connector name, camelCase). */
  namespace: string;
  /**
   * Checksum over the compiled contract. An installation records the checksum
   * it was configured against, so a contract change that invalidates existing
   * configuration is detectable instead of silently breaking at runtime.
   */
  checksum: string;
}
