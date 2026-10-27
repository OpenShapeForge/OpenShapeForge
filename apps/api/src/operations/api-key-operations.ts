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
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { ApiKeyAuthorizationError } from "../auth/api-key/ceiling.js";
import {
  readApiKeyProvisioningConfig,
  type ApiKeyProvisioningConfig,
} from "../auth/api-key/runtime-config.js";
import {
  ApiKeyNotFoundError,
  ApiKeyValidationError,
  disableIntegration,
  getIntegration,
  getKey,
  issueKey,
  listIntegrations,
  listKeys,
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
 * Only the four the exposed paths can raise. Anything else is ours, not the
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
  throw error;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
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
 * The declared collection query, applied to an authorized result set.
 *
 * The cursor is an opaque offset into the SORTED, FILTERED page — the same
 * shape the platform tenant listing uses. A cursor that no longer addresses a
 * row (the set shrank under it) is a client error rather than a silent empty
 * page, because a caller paging forward would otherwise never learn that it
 * skipped the tail.
 */
const MAX_PAGE_OFFSET = 100_000;

function decodeCursor(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "string") {
    throw new ApiKeyValidationError("after must be a cursor returned by this listing.");
  }
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  const offset = /^\d+$/.test(decoded) ? Number(decoded) : Number.NaN;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_PAGE_OFFSET) {
    throw new ApiKeyValidationError("after must be a cursor returned by this listing.");
  }
  return offset;
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

type SortableValue = string | number | null;

type PageInput = {
  first?: unknown;
  after?: unknown;
  sortField?: unknown;
  sortDirection?: unknown;
};

type Page<T> = { items: T[]; totalCount: number; nextCursor: string | null };

/**
 * `first`, `sortField` and `sortDirection` are already bounded by the compiled
 * input schema the runtime validated, so this reads them rather than
 * re-deriving their limits. `defaultFirst` and `defaultSort` restate the
 * authored defaults for the direct (non-transport) caller that passes neither.
 */
function paginate<T>(
  rows: readonly T[],
  input: PageInput,
  options: {
    defaultFirst: number;
    defaultSort: { field: string; direction: "asc" | "desc" };
    value: (row: T, field: string) => SortableValue;
    tiebreak: (row: T) => string;
  },
): Page<T> {
  const field = typeof input.sortField === "string" ? input.sortField : options.defaultSort.field;
  const direction = input.sortDirection === "asc" || input.sortDirection === "desc"
    ? input.sortDirection
    : options.defaultSort.direction;
  const first = typeof input.first === "number" && Number.isInteger(input.first) && input.first > 0
    ? input.first
    : options.defaultFirst;
  const sign = direction === "desc" ? -1 : 1;
  const sorted = [...rows].sort((left, right) => {
    const leftValue = options.value(left, field);
    const rightValue = options.value(right, field);
    // A missing value sorts last in both directions: "no expiry" and "never
    // used" are not the smallest date, they are the absence of one.
    if (leftValue === null || rightValue === null) {
      if (leftValue === rightValue) return options.tiebreak(left).localeCompare(options.tiebreak(right), "en");
      return leftValue === null ? 1 : -1;
    }
    const ordered = typeof leftValue === "number" && typeof rightValue === "number"
      ? Math.sign(leftValue - Number(rightValue))
      : String(leftValue).localeCompare(String(rightValue), "en", { sensitivity: "base", numeric: true });
    return ordered === 0
      ? options.tiebreak(left).localeCompare(options.tiebreak(right), "en")
      : ordered * sign;
  });
  const offset = decodeCursor(input.after);
  if (offset > sorted.length) {
    throw new ApiKeyValidationError("after points beyond the end of this listing.");
  }
  const items = sorted.slice(offset, offset + first);
  const nextOffset = offset + items.length;
  return {
    items,
    totalCount: sorted.length,
    nextCursor: nextOffset < sorted.length ? encodeCursor(nextOffset) : null,
  };
}

/** A free-text filter the authored input declares: contains, case-insensitive. */
function matches(value: string, query: unknown): boolean {
  if (typeof query !== "string" || query.trim() === "") return true;
  return value.toLocaleLowerCase("en").includes(query.trim().toLocaleLowerCase("en"));
}

function equals(value: string, query: unknown): boolean {
  return typeof query !== "string" || query === "" ? true : value === query;
}

const HANDLERS: Record<string, ModuleOperationHandler> = {
  async listIntegrations(input, context): Promise<ModuleOperationResult> {
    const resolved = resolve(context);
    if (isFailure(resolved)) return resolved;
    try {
      const all = (await listIntegrations(resolved.deps, resolved.session)).map(projectIntegration);
      const filtered = all.filter((integration) =>
        matches(integration.displayName, input.displayName) && equals(integration.status, input.status)
      );
      const page = paginate(filtered, input, {
        defaultFirst: 25,
        defaultSort: { field: "displayName", direction: "asc" },
        value: (row, field) => integrationSortValue(row, field),
        tiebreak: (row) => row.integrationId,
      });
      return {
        value: { integrations: page.items, totalCount: page.totalCount, nextCursor: page.nextCursor },
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
      await getIntegration(resolved.deps, resolved.session, integrationId);
      const all = (await listKeys(resolved.deps, resolved.session, { integrationId }))
        .map((key) => projectCredential(key, now));
      const filtered = all.filter((credential) =>
        matches(credential.displayName, input.displayName) && equals(credential.status, input.status)
      );
      const page = paginate(filtered, input, {
        defaultFirst: 25,
        defaultSort: { field: "createdAt", direction: "desc" },
        value: (row, field) => credentialSortValue(row, field),
        tiebreak: (row) => row.id,
      });
      return {
        value: { credentials: page.items, totalCount: page.totalCount, nextCursor: page.nextCursor },
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

  async issueCredential(input, context): Promise<ModuleOperationResult> {
    const resolved = resolve(context);
    if (isFailure(resolved)) return resolved;
    try {
      const created = await issueKey(resolved.deps, resolved.session, {
        integrationId: text(input.integrationId),
        displayName: text(input.displayName),
        // Omitted and null are different requests: omitted takes the
        // deployment default lifetime, null means "never expires".
        ...(input.expiresInDays === undefined
          ? {}
          : { expiresInDays: input.expiresInDays as number | null }),
        ...(input.roleSubset === undefined
          ? {}
          : { roleSubset: input.roleSubset as string[] | null }),
      });
      // The one place the credential is returned. Not logged, not cached, not
      // readable again: the row stores only its hash.
      return {
        value: {
          integrationId: created.integrationId,
          id: created.keyId,
          secret: created.token,
          expiresAt: iso(created.expiresAt),
        },
      };
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

function integrationSortValue(row: ProjectedIntegration, field: string): SortableValue {
  switch (field) {
    case "status": return row.status;
    case "createdAt": return row.createdAt;
    case "updatedAt": return row.updatedAt;
    default: return row.displayName;
  }
}

function credentialSortValue(row: ProjectedCredential, field: string): SortableValue {
  switch (field) {
    case "status": return row.status;
    case "createdAt": return row.createdAt;
    case "expiresAt": return row.expiresAt;
    case "lastUsedAt": return row.lastUsedAt;
    default: return row.displayName;
  }
}

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
