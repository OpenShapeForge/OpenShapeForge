// SPDX-License-Identifier: BUSL-1.1
/**
 * The core `osf-api-keys` runtime: the integration/API-key catalog as canonical
 * Operations (packages/compiler/config/authoring/operations/api-key-integrations.yaml).
 *
 * Thin on purpose. Every handler here calls `auth/api-key/service.ts`, which
 * calls `auth/api-key/ceiling.ts` — the single authorization decision of this
 * whole feature: the management role, "nobody grants a role they do not hold",
 * and the refusal of an API key session to manage API keys. Nothing in this
 * file re-decides any of that, and nothing in it talks to Postgres or Keycloak
 * directly, so the existing REST and GraphQL surfaces and this catalog are
 * three projections of one authority rather than three implementations.
 *
 * What this file DOES own is projection: Dates to ISO strings, the derived
 * credential status a reader thinks in (active / expired / revoked), and the
 * sort-and-page contract the generic collection view declares. That contract is
 * applied to an already-authorized result set, which is why it can live here
 * and not in the service: it decides what a page SHOWS, never what a caller MAY
 * see. The sets are bounded (integrations per tenant, keys per integration), so
 * paging in memory is the same trade the platform catalog already makes for
 * tenants (control/platform-catalog.ts).
 *
 * The secret appears in exactly one place: the value of `issueCredential`. It
 * is never logged, never read back, and never projected to the web — see the
 * catalog YAML for why that projection is absent rather than merely unused.
 */
import { createHash } from "node:crypto";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { ApiKeyAuthorizationError } from "../auth/api-key/ceiling.js";
import {
  readApiKeyProvisioningConfig,
  type ApiKeyProvisioningConfig,
} from "../auth/api-key/runtime-config.js";
import type { KeysetCursor } from "../auth/api-key/catalog-page.js";
import { PRODUCT_MAX_CREDENTIAL_TTL_DAYS } from "../auth/api-key/lifetime.js";
import {
  ApiKeyNotFoundError,
  ApiKeyProvisioningError,
  ApiKeyValidationError,
  createIntegration,
  disableIntegration,
  getIntegration,
  getKey,
  issueKey,
  MAX_PAGE_SIZE,
  pageIntegrations,
  pageKeys,
  revokeKey,
  type ApiKeyServiceDeps,
  type ListedIntegration,
  type ListedKey,
  type ProvisioningSession,
} from "../auth/api-key/service.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type {
  ModuleOperationContext,
  ModuleOperationErrorResult,
  ModuleOperationHandler,
  ModuleOperationResult,
} from "../modules/contract.js";
import type { OperationContract } from "./runtime.js";

/** The plugin name every integration catalog Operation is authored under. */
export const API_KEYS_PLUGIN = "osf-api-keys";

function declaredFailure(status: number, code: string, message: string): ModuleOperationErrorResult {
  return { ok: false, status, code, body: { error: { code, message, retryable: false } } };
}

/**
 * What a handler needs, or the declared refusal that replaces it.
 *
 * Absent provisioning configuration disables the whole catalog rather than its
 * mutations only. That is the rule `runtime-config.ts` already states and
 * `rest-routes.ts` already applies by refusing to register: a deployment that
 * cannot provision is not a deployment that half-manages integrations, and a
 * read-only catalog on such a host would advertise a surface whose actions can
 * never work. A canonical Operation cannot un-register, so it says so instead.
 */
type Resolved = {
  deps: ApiKeyServiceDeps;
  session: ProvisioningSession;
};

function isFailure(value: Resolved | ModuleOperationErrorResult): value is ModuleOperationErrorResult {
  return "ok" in value && value.ok === false;
}

function resolve(context: ModuleOperationContext): Resolved | ModuleOperationErrorResult {
  const db = context.db as OpenShapeForgeDatabase | undefined;
  const config: ApiKeyProvisioningConfig | undefined = readApiKeyProvisioningConfig();
  if (!db || !config) {
    return declaredFailure(
      503,
      "NOT_CONFIGURED",
      "API key provisioning is not configured on this deployment.",
    );
  }
  const session = context.session as TrustedSessionContext | undefined;
  if (!session?.tenantId || !session.userId) {
    return declaredFailure(401, "UNAUTHENTICATED", "An authenticated tenant session is required.");
  }
  return {
    deps: {
      db,
      keyring: config.keyring,
      admin: config.admin,
      entityRoleClientId: config.entityRoleClientId,
      lifetime: config.lifetime,
    },
    // `credential` and `principalKind` are carried through untouched: together
    // they are the ceiling's carrier rule, so flattening either here would
    // disable that control for every Operation in this catalog.
    session: {
      tenantId: session.tenantId,
      userId: session.userId,
      roles: session.roles,
      groups: session.groups,
      credential: session.credential,
      ...(session.principalKind ? { principalKind: session.principalKind } : {}),
    },
  };
}

/**
 * Map the service's own errors onto this catalog's declared ones.
 *
 * Only the ones the exposed paths can raise. Anything else is ours, not the
 * caller's, and is rethrown so the runtime reports an internal failure rather
 * than describing it.
 */
function declaredServiceFailure(error: unknown): ModuleOperationErrorResult {
  if (error instanceof ApiKeyAuthorizationError) {
    return declaredFailure(403, "FORBIDDEN", error.message);
  }
  if (error instanceof ApiKeyNotFoundError) {
    return declaredFailure(404, "NOT_FOUND", error.message);
  }
  if (error instanceof ApiKeyValidationError) {
    return declaredFailure(400, "VALIDATION", error.message);
  }
  if (error instanceof ApiKeyProvisioningError) {
    // Only `createIntegration` mutates the realm, and only its contract
    // declares this status; every other Operation here would be a handler
    // contract violation if it reached this branch, which is the intent.
    return declaredFailure(502, "PROVISIONING_FAILED", error.message);
  }
  throw error;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/**
 * The longest life this contract will ask for, in days.
 *
 * 366 is the product's own boundary — a credential that survives a yearly
 * review, or one that never expires at all, is not something a generic
 * integration form may request on anyone's behalf. The authored input schema
 * states the same bound, so every transport is refused before the handler;
 * this restates it for a direct caller and is what a drift test pins against
 * the schema.
 *
 * It is the CONTRACT's bound and nothing else. A deployment that needs a
 * tighter rule declares one (`auth/api-key/lifetime.ts`), and the service
 * applies it to every minting surface — so the number a caller is actually
 * held to may be lower than this, and the refusal then names that number
 * rather than this one. No deployment can raise it, and a deployment that
 * declares nothing leaves the long-lived REST and GraphQL mounts exactly as
 * they were: this bound is not retroactively imposed on them.
 */
export const MAX_CREDENTIAL_TTL_DAYS = PRODUCT_MAX_CREDENTIAL_TTL_DAYS;

/**
 * Normalise the requested lifetime, or refuse it.
 *
 * `null` is refused rather than forwarded. The service reads it as "never
 * expires", which is exactly the silent widening this contract must not offer:
 * omitting the field takes the deployment default instead.
 */
function lifetime(value: unknown): { expiresInDays?: number } {
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ApiKeyValidationError(
      `expiresInDays must be an integer from 1 through ${MAX_CREDENTIAL_TTL_DAYS}.`,
    );
  }
  if (value > MAX_CREDENTIAL_TTL_DAYS) {
    throw new ApiKeyValidationError(
      `A credential may live at most ${MAX_CREDENTIAL_TTL_DAYS} days.`,
    );
  }
  return { expiresInDays: value };
}

/** A non-empty list of role names, refused rather than coerced. */
function roleList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((role) => typeof role !== "string")) {
    throw new ApiKeyValidationError(`${name} must be a list of role names.`);
  }
  if (value.length === 0) {
    throw new ApiKeyValidationError(`${name} must name at least one role.`);
  }
  return value as string[];
}

/**
 * Response headers for a result that carries a live credential.
 *
 * `no-store` is the one that matters: without it a shared cache, a browser
 * back button or a proxy may keep the only copy of a secret that is, by
 * design, never retrievable again. `private` and the legacy `pragma` cover
 * intermediaries that predate it. The REST adapter applies these verbatim
 * (operations/runtime.ts), so the header travels with the canonical Operation
 * rather than being something each transport has to remember.
 */
export const ONE_TIME_CREDENTIAL_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "cache-control": "private, no-store, max-age=0",
  pragma: "no-cache",
});

/** The credential half of a mint: returned here, once, and never read back. */
function mintedCredential(created: { keyId: string; token: string; expiresAt: Date | null }) {
  if (created.expiresAt === null) {
    // Unreachable through this contract — `lifetime` refuses null and the
    // service defaults to a finite TTL — and refused rather than reported, so
    // a future change to either cannot hand out a non-expiring credential
    // through a form that promises a lifetime.
    throw new ApiKeyValidationError("A credential issued here must have an expiry.");
  }
  return { id: created.keyId, secret: created.token, expiresAt: created.expiresAt.toISOString() };
}

function oneTimeCredential(value: Record<string, unknown>): ModuleOperationResult {
  return { value, headers: { ...ONE_TIME_CREDENTIAL_HEADERS } };
}

/** Status as a reader thinks about a credential, derived from the two instants. */
export type CredentialStatus = "active" | "expired" | "revoked";

export function credentialStatus(key: Pick<ListedKey, "revokedAt" | "expiresAt">, now: Date): CredentialStatus {
  if (key.revokedAt !== null) return "revoked";
  if (key.expiresAt !== null && key.expiresAt.getTime() <= now.getTime()) return "expired";
  return "active";
}

type ProjectedIntegration = {
  integrationId: string;
  displayName: string;
  status: ListedIntegration["status"];
  grantedRoles: string[];
  credentialCount: number;
  activeCredentialCount: number;
  createdAt: string;
  updatedAt: string;
};

function projectIntegration(integration: ListedIntegration): ProjectedIntegration {
  return {
    integrationId: integration.id,
    displayName: integration.displayName,
    status: integration.status,
    grantedRoles: integration.grantedRoles,
    credentialCount: integration.keyCount,
    activeCredentialCount: integration.activeKeyCount,
    createdAt: integration.createdAt.toISOString(),
    updatedAt: integration.updatedAt.toISOString(),
  };
}

type ProjectedCredential = {
  id: string;
  integrationId: string;
  integrationName: string;
  displayName: string;
  status: CredentialStatus;
  roleSubset: string[] | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
};

function projectCredential(key: ListedKey, now: Date): ProjectedCredential {
  return {
    id: key.id,
    integrationId: key.integrationId,
    integrationName: key.integrationName,
    displayName: key.displayName,
    status: credentialStatus(key, now),
    roleSubset: key.roleSubset,
    createdAt: key.createdAt.toISOString(),
    expiresAt: iso(key.expiresAt),
    revokedAt: iso(key.revokedAt),
    lastUsedAt: iso(key.lastUsedAt),
  };
}

/**
 * The opaque `after` cursor: the database keyset, plus the query it belongs to.
 *
 * The keyset alone would be resumable under a DIFFERENT sort or filter, where
 * "everything after this value" means something else entirely and silently
 * skips or repeats rows. So the cursor carries a fingerprint of the sort and
 * the filters it was issued for, and a request whose own sort or filters do
 * not match it is refused as a client error instead of answered with a page
 * that looks fine and is not.
 *
 * The fingerprint is a hash, so the cursor stays short, but it is NOT a
 * security boundary and is not relied on as one: the tenant comes from the
 * session and the subject from the request, both re-applied as SQL predicates
 * on every statement, so the worst a forged cursor can do is pick a different
 * resume point inside a set the caller may already read.
 */
type CursorPayload = {
  /** Sort field and direction this cursor was issued under. */
  f: string;
  d: "asc" | "desc";
  /** Fingerprint of the subject and filters. */
  q: string;
  /** The last row's sort value as the database rendered it; null in the NULL block. */
  v: string | null;
  /** The last row's id — the tie-break half of the keyset. */
  i: string;
};

/**
 * The shape a cursor's sort value must have to be bound at all.
 *
 * Both halves of a keyset reach a TYPED expression: the id is compared against
 * a uuid column, and a date sort's value is cast to timestamptz
 * (`catalog-page.ts`, `bind`). PostgreSQL answers a malformed one with
 * `invalid input syntax`, which is a 500 reported to a caller who only
 * supplied a bad cursor — a contract this Operation does not declare and an
 * internal failure it should never log. So both are checked here, against the
 * shape the database itself rendered, before any value is bound.
 *
 * The fingerprint does not make this unnecessary. It covers the sort and the
 * filters so a cursor cannot resume the wrong SET, and it is deliberately not
 * a security boundary: it is derived from public inputs, so anyone can
 * produce a cursor that matches their own query and carries whatever keyset
 * they like. Rejecting on shape is what keeps that a client error.
 */
/**
 * The 8-4-4-4-12 hex shape, deliberately NOT the stricter RFC 4122 pattern the
 * session layer applies: this only has to be a value the uuid type accepts, and
 * a row id is whatever the database minted, not something to re-validate.
 */
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `timestamptz::text` under DateStyle ISO, which is what `sort_value` is: a
 * date, a space, a time with up to microsecond precision, and the offset.
 * Anchored, so nothing may follow the value that Postgres would then have to
 * interpret.
 */
const CURSOR_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2}(:\d{2})?)?$/;

/** The sorts whose value is a timestamp rather than text (service.ts). */
const TIMESTAMP_SORTS = new Set(["createdAt", "updatedAt", "expiresAt", "lastUsedAt"]);

/**
 * The longest text sort value a cursor may carry.
 *
 * `lower(display_name)` is the only text sort value, and the authored input
 * bounds a display name at 200 characters; `status` is one short word. Past
 * that the cursor is not one this listing produced.
 */
const MAX_CURSOR_VALUE_LENGTH = 200;

function fingerprint(parts: readonly (string | undefined)[]): string {
  return createHash("sha256").update(JSON.stringify(parts.map((part) => part ?? null)))
    .digest("base64url").slice(0, 16);
}

function invalidCursor(): never {
  // Deliberately one message for every rejection: a caller that tampered with
  // a cursor learns that it was rejected, not which half gave it away.
  throw new ApiKeyValidationError("after must be a cursor this listing returned for this same query.");
}

function decodeCursor(value: unknown, sort: { f: string; d: string }, query: string): KeysetCursor | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 512) invalidCursor();
  let payload: CursorPayload;
  try {
    payload = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as CursorPayload;
  } catch {
    invalidCursor();
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) invalidCursor();
  if (typeof payload.i !== "string" || !CURSOR_ID.test(payload.i)) invalidCursor();
  if (payload.v !== null && typeof payload.v !== "string") invalidCursor();
  // Sort or filter tampering: the keyset is only meaningful under the order
  // and the set it was produced in.
  if (payload.f !== sort.f || payload.d !== sort.d || payload.q !== query) invalidCursor();
  // The sort is now known to be the one the caller asked for, so its value's
  // type is known too. Checked against the shape the database renders, never
  // left for the cast to reject — see CURSOR_TIMESTAMP.
  if (payload.v !== null) {
    if (TIMESTAMP_SORTS.has(payload.f)) {
      if (!CURSOR_TIMESTAMP.test(payload.v)) invalidCursor();
    } else if (payload.v.length > MAX_CURSOR_VALUE_LENGTH) invalidCursor();
  }
  return { value: payload.v, id: payload.i };
}

function encodeCursor(
  cursor: KeysetCursor | null,
  sort: { f: string; d: "asc" | "desc" },
  query: string,
): string | null {
  if (!cursor) return null;
  const payload: CursorPayload = { f: sort.f, d: sort.d, q: query, v: cursor.value, i: cursor.id };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Read the sort, direction and page size the caller asked for.
 *
 * The compiled input schema the runtime validated already bounds all three —
 * `sortField` to its enum, `first` to 1..100 — so this reads them and restates
 * the authored defaults for a direct caller that passes none. An unsupported
 * sort cannot arrive through a transport; one that does arrive is refused
 * rather than quietly answered in some other order.
 */
function readSort<TField extends string>(
  input: Record<string, unknown>,
  supported: readonly TField[],
  defaults: { field: TField; direction: "asc" | "desc" },
): { field: TField; direction: "asc" | "desc"; first: number } {
  const field = input.sortField === undefined ? defaults.field : input.sortField;
  if (typeof field !== "string" || !supported.includes(field as TField)) {
    throw new ApiKeyValidationError(
      `sortField must be one of ${[...supported].sort().join(", ")}.`,
    );
  }
  const direction = input.sortDirection === undefined ? defaults.direction : input.sortDirection;
  if (direction !== "asc" && direction !== "desc") {
    throw new ApiKeyValidationError("sortDirection must be asc or desc.");
  }
  const first = input.first === undefined ? DEFAULT_PAGE_SIZE : input.first;
  if (typeof first !== "number" || !Number.isInteger(first) || first < 1 || first > MAX_PAGE_SIZE) {
    throw new ApiKeyValidationError(`first must be an integer from 1 through ${MAX_PAGE_SIZE}.`);
  }
  return { field: field as TField, direction, first };
}

/** `exactOptionalPropertyTypes` forbids `after: undefined`; omit the key instead. */
function cursorSpread(after: KeysetCursor | undefined): { after?: KeysetCursor } {
  return after ? { after } : {};
}

/** The authored `first.default`; the compiler test pins the two together. */
const DEFAULT_PAGE_SIZE = 25;

const INTEGRATION_SORTS = ["displayName", "status", "createdAt", "updatedAt"] as const;
const CREDENTIAL_SORTS = ["displayName", "status", "createdAt", "expiresAt", "lastUsedAt"] as const;

/** An optional string filter, rejected rather than coerced. */
function filter(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ApiKeyValidationError(`${name} must be a string.`);
  return value;
}

const HANDLERS: Record<string, ModuleOperationHandler> = {
  async listIntegrations(input, context): Promise<ModuleOperationResult> {
    const resolved = resolve(context);
    if (isFailure(resolved)) return resolved;
    try {
      const sort = readSort(input, INTEGRATION_SORTS, { field: "displayName", direction: "asc" });
      const displayName = filter(input.displayName, "displayName");
      const status = filter(input.status, "status");
      const identity = { f: sort.field, d: sort.direction };
      // The tenant is NOT in the fingerprint: it comes from the session and is
      // a predicate on every statement, so a cursor cannot carry one.
      const query = fingerprint(["integrations", displayName, status]);
      const page = await pageIntegrations(resolved.deps, resolved.session, {
        sortField: sort.field,
        sortDirection: sort.direction,
        first: sort.first,
        ...cursorSpread(decodeCursor(input.after, identity, query)),
        ...(displayName === undefined ? {} : { displayName }),
        ...(status === undefined ? {} : { status }),
      });
      return {
        value: {
          integrations: page.rows.map(projectIntegration),
          totalCount: page.totalCount,
          nextCursor: encodeCursor(page.nextCursor, identity, query),
        },
      };
    } catch (error) {
      return declaredServiceFailure(error);
    }
  },

  async getIntegration(input, context): Promise<ModuleOperationResult> {
    const resolved = resolve(context);
    if (isFailure(resolved)) return resolved;
    try {
      const integration = await getIntegration(resolved.deps, resolved.session, text(input.integrationId));
      return { value: projectIntegration(integration) };
    } catch (error) {
      return declaredServiceFailure(error);
    }
  },

  async listCredentials(input, context): Promise<ModuleOperationResult> {
    const resolved = resolve(context);
    if (isFailure(resolved)) return resolved;
    const now = new Date();
    try {
      const integrationId = text(input.integrationId);
      // The integration is read first so an id this tenant does not hold is a
      // NOT_FOUND rather than an empty page of credentials.
      await getIntegration(resolved.deps, resolved.session, integrationId, now);
      const sort = readSort(input, CREDENTIAL_SORTS, { field: "createdAt", direction: "desc" });
      const displayName = filter(input.displayName, "displayName");
      const status = filter(input.status, "status");
      const identity = { f: sort.field, d: sort.direction };
      // The integration IS in the fingerprint: a cursor issued under one
      // parent must not resume a page under another, even within one tenant.
      const query = fingerprint(["credentials", integrationId, displayName, status]);
      const page = await pageKeys(resolved.deps, resolved.session, { integrationId }, {
        sortField: sort.field,
        sortDirection: sort.direction,
        first: sort.first,
        ...cursorSpread(decodeCursor(input.after, identity, query)),
        ...(displayName === undefined ? {} : { displayName }),
        ...(status === undefined ? {} : { status }),
      }, now);
      return {
        value: {
          credentials: page.rows.map((key) => projectCredential(key, now)),
          totalCount: page.totalCount,
          nextCursor: encodeCursor(page.nextCursor, identity, query),
        },
      };
    } catch (error) {
      return declaredServiceFailure(error);
    }
  },

  async getCredential(input, context): Promise<ModuleOperationResult> {
    const resolved = resolve(context);
    if (isFailure(resolved)) return resolved;
    try {
      const key = await getKey(resolved.deps, resolved.session, {
        keyId: text(input.id),
        integrationId: text(input.integrationId),
      });
      return { value: projectCredential(key, new Date()) };
    } catch (error) {
      return declaredServiceFailure(error);
    }
  },

  async createIntegration(input, context): Promise<ModuleOperationResult> {
    const resolved = resolve(context);
    if (isFailure(resolved)) return resolved;
    const now = new Date();
    try {
      // The ceiling bounds `roles` and `roleSubset` against what this caller
      // itself holds, inside the service. Nothing is re-decided here.
      const created = await createIntegration(resolved.deps, resolved.session, {
        displayName: text(input.displayName),
        roles: roleList(input.roles, "roles"),
        ...lifetime(input.expiresInDays),
        ...(input.roleSubset === undefined
          ? {}
          : { roleSubset: roleList(input.roleSubset, "roleSubset") }),
      }, now);
      // The metadata comes out of the SAME transaction that minted the
      // credential, not from a read-back after it. A read-back is a step
      // between holding the only copy of a secret and handing it over: its
      // failure reports an error for work that committed, and the retry
      // provisions a second realm client and a second credential. These are
      // still the row's own values rather than an echo of the input — the
      // service trims the name and flips the status (service.ts,
      // CreatedApiKey.integration).
      return oneTimeCredential({
        integration: {
          integrationId: created.integrationId,
          displayName: created.integration.displayName,
          status: created.integration.status,
          grantedRoles: created.integration.grantedRoles,
          createdAt: created.integration.createdAt.toISOString(),
        },
        credential: mintedCredential(created),
      });
    } catch (error) {
      return declaredServiceFailure(error);
    }
  },

  async issueCredential(input, context): Promise<ModuleOperationResult> {
    const resolved = resolve(context);
    if (isFailure(resolved)) return resolved;
    try {
      const created = await issueKey(resolved.deps, resolved.session, {
        integrationId: text(input.integrationId),
        displayName: text(input.displayName),
        ...lifetime(input.expiresInDays),
        ...(input.roleSubset === undefined
          ? {}
          : { roleSubset: roleList(input.roleSubset, "roleSubset") }),
      });
      return oneTimeCredential({
        integrationId: created.integrationId,
        credential: mintedCredential(created),
      });
    } catch (error) {
      return declaredServiceFailure(error);
    }
  },

  async revokeCredential(input, context): Promise<ModuleOperationResult> {
    const resolved = resolve(context);
    if (isFailure(resolved)) return resolved;
    try {
      const revoked = await revokeKey(resolved.deps, resolved.session, text(input.id));
      return { value: { id: revoked.id, status: "revoked", revokedAt: revoked.revokedAt.toISOString() } };
    } catch (error) {
      return declaredServiceFailure(error);
    }
  },

  async disableIntegration(input, context): Promise<ModuleOperationResult> {
    const resolved = resolve(context);
    if (isFailure(resolved)) return resolved;
    try {
      const disabled = await disableIntegration(
        resolved.deps,
        resolved.session,
        text(input.integrationId),
      );
      return {
        value: {
          integrationId: disabled.id,
          status: "disabled",
          revokedCredentials: disabled.revokedKeys,
        },
      };
    } catch (error) {
      return declaredServiceFailure(error);
    }
  },
};

export function apiKeyOperationHandlerNames(): readonly string[] {
  return Object.keys(HANDLERS).sort();
}

export function apiKeyOperationHandler(
  operation: Pick<OperationContract, "key" | "handler">,
): ModuleOperationHandler {
  const run = HANDLERS[operation.handler];
  if (!run) throw new Error(`Unknown core API key catalog handler "${operation.handler}".`);
  return run;
}
