// SPDX-License-Identifier: BUSL-1.1
import "server-only";

import { getCachedSession } from "@/lib/cached-session";

/**
 * The control-plane API client — the ONLY module in this app that knows
 * `apps/api` exists.
 *
 * WHY THE ISOLATION IS THE POINT. Confining every mention of the control
 * surface to one module means that when it moves behind a gateway, changes
 * host, or grows a different auth scheme, the edit is MECHANICAL: one file, no
 * call-site archaeology. Pages and server actions must not call it directly —
 * they call the operations below.
 *
 * ── How the caller is authenticated (settled by #289) ───────────────────────
 *
 * The operator's OWN control-realm access token, forwarded as a bearer. Not the
 * signed trusted-context headers `apps/web` uses, and that is the control
 * surface's decision rather than this app's convenience: `src/control/
 * authorization.ts` refuses trusted-context entirely, because those headers
 * carry arbitrary roles under one shared secret, and on a cross-tenant surface
 * that would mean anything holding the secret could claim to be an operator.
 *
 * Forwarding the operator's token also keeps the audit trail honest. Every
 * control-plane mutation writes a `platform.system_bypass_audit` row naming the
 * issuer-qualified subject from that token, so the row says WHICH operator
 * acted rather than "the admin app". A shared service credential would erase
 * exactly the fact the audit exists to record.
 *
 * The token is not, and must never be, forwarded to the Keycloak SPI — see
 * `keycloak-spi.ts` for why that is structurally impossible anyway.
 *
 * ── Errors are values, not exceptions ───────────────────────────────────────
 *
 * Every operation returns a discriminated result. The control surface answers
 * with a code vocabulary that pages need to DISCRIMINATE on rather than merely
 * display — a malformed slug (400 CONTROL_INVALID_INPUT) belongs on the field
 * that produced it, an idempotent replay (200 with `created: false`) is a
 * success worth wording differently, and a 503 means the deployment is
 * unconfigured rather than the request wrong. Throwing would flatten all three
 * into one error boundary.
 */

// 127.0.0.1 rather than "localhost" for the same reason apps/web's gateway
// module does it: Node's fetch prefers ::1, while the API dev server is often
// bound IPv4-only, which shows up as an intermittent ECONNREFUSED on macOS.
const DEFAULT_CONTROL_API_URL = "http://127.0.0.1:3001";

/**
 * The mount `apps/api` publishes the control surface on — a distinct prefix
 * from `/api/rest/v1`, deliberately, so keeping the control plane off a public
 * ingress stays a path rule (#294) rather than an exception list.
 */
const CONTROL_API_PREFIX = "/api/control/v1";

function normalizeBaseUrl(raw: string): string {
  return raw.endsWith("/") ? raw : `${raw}/`;
}

export function getControlApiBaseUrl(): string {
  const raw =
    process.env.OPENSHAPEFORGE_CONTROL_API_URL ??
    process.env.OPENSHAPEFORGE_GATEWAY_URL ??
    DEFAULT_CONTROL_API_URL;

  return normalizeBaseUrl(raw);
}

export function buildControlApiUrl(path: string): URL {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return new URL(`${CONTROL_API_PREFIX}${suffix}`.replace(/^\//, ""), getControlApiBaseUrl());
}

/**
 * The single transport for control-plane calls.
 *
 * `cache: "no-store"` is not a default worth inheriting from Next here: tenant
 * state is administrative data that an operator has just changed, and a cached
 * read of it is a bug report waiting to happen.
 */
export async function callControlApi(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(buildControlApiUrl(path).toString(), {
    ...init,
    cache: "no-store",
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

// ---------------------------------------------------------------------------
// Types, mirroring `apps/api/src/control/tenant-registry.ts`

/** The TENANTSTATUS codetable, as the control surface validates it. */
export const TENANT_STATUSES = ["active", "inactive", "suspended"] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export type Tenant = {
  id: string;
  slug: string;
  name: string;
  status: string;
  keycloakOrganizationId: string | null;
  keycloakRealm: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TenantOrganization = {
  id: string;
  alias: string;
  name: string;
  enabled: boolean;
};

export type TenantDetail = {
  tenant: Tenant;
  /** Keycloak as it actually is, or null when there is no link (or no answer). */
  organization: TenantOrganization | null;
  /** Set when Keycloak could not be read; the registry row is still authoritative. */
  organizationError: string | null;
};

export type CreatedTenant = {
  tenant: Tenant;
  organization: { id: string; alias: string; path: string };
  /** False on an idempotent replay — the tenant was already there. */
  created: boolean;
};

export type UpdatedTenant = {
  tenant: Tenant;
  organization: { id: string; enabled: boolean; changed: boolean } | null;
  changed: boolean;
};

/**
 * A refusal the control surface stated, carried rather than thrown.
 *
 * `code` is the surface's own vocabulary (`CONTROL_INVALID_INPUT`,
 * `CONTROL_TENANT_NOT_FOUND`, `KEYCLOAK_ADMIN_*`, …). Pages branch on it; the
 * message is written for an operator and is safe to show, because the control
 * surface redacts anything it has not classified into a generic 500.
 */
export type ControlApiFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

export type ControlApiResult<T> = ({ ok: true } & T) | ControlApiFailure;

// ---------------------------------------------------------------------------
// Transport

/**
 * "Not signed in" is presented as a failure rather than a redirect, because
 * these run inside pages and server actions that have already been through
 * `requireOperatorSession`. Reaching this means the session evaporated
 * mid-request, and the honest answer is to say so rather than to bounce a POST
 * through a login round trip that would lose the form.
 */
async function operatorAuthorization(): Promise<
  { ok: true; header: string } | ControlApiFailure
> {
  const session = await getCachedSession();
  if (!session?.accessToken) {
    return {
      ok: false,
      status: 401,
      code: "NO_OPERATOR_SESSION",
      message: "Your session has expired. Sign in again and retry.",
    };
  }
  return { ok: true, header: `Bearer ${session.accessToken}` };
}

async function readFailure(response: Response): Promise<ControlApiFailure> {
  // The surface answers `{ error: { code, message } }`. Anything else means a
  // proxy or a crash got there first, in which case the status is all there is.
  let code = "CONTROL_API_ERROR";
  let message = `The control plane answered ${response.status}.`;
  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
    if (typeof body?.error?.code === "string") code = body.error.code;
    if (typeof body?.error?.message === "string") message = body.error.message;
  } catch {
    // Keep the status-derived defaults.
  }
  return { ok: false, status: response.status, code, message };
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<ControlApiResult<T>> {
  const authorization = await operatorAuthorization();
  if (!authorization.ok) return authorization;

  let response: Response;
  try {
    response = await callControlApi(path, {
      ...init,
      headers: { authorization: authorization.header, ...init.headers },
    });
  } catch (error) {
    // A dev stack with the API down is the common case, and "fetch failed" in a
    // red box tells an operator nothing about which process to start.
    return {
      ok: false,
      status: 503,
      code: "CONTROL_API_UNREACHABLE",
      message:
        `The control plane API at ${getControlApiBaseUrl()} could not be reached: ` +
        (error instanceof Error ? error.message : String(error)),
    };
  }

  if (!response.ok) return readFailure(response);
  return { ok: true, ...((await response.json()) as T) };
}

// ---------------------------------------------------------------------------
// Operations

export async function listTenants(): Promise<
  ControlApiResult<{ tenants: Tenant[]; truncated: boolean }>
> {
  return request("/tenants");
}

export async function getTenant(slug: string): Promise<ControlApiResult<TenantDetail>> {
  return request(`/tenants/${encodeURIComponent(slug)}`);
}

export async function createTenant(input: {
  slug: string;
  name: string;
}): Promise<ControlApiResult<CreatedTenant>> {
  return request("/tenants", { method: "POST", body: JSON.stringify(input) });
}

/**
 * Change a tenant's lifecycle state or display name.
 *
 * There is deliberately NO slug parameter. The slug is the Keycloak
 * Organization alias and the URL key, and it is immutable — the control surface
 * refuses a body carrying one, and this signature makes sending one impossible
 * from here rather than merely refused there.
 */
export async function updateTenant(
  slug: string,
  update: { status?: TenantStatus; name?: string },
): Promise<ControlApiResult<UpdatedTenant>> {
  return request(`/tenants/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    body: JSON.stringify(update),
  });
}

// ---------------------------------------------------------------------------
// Sub-organisations, mirroring `apps/api/src/control/org-unit-registry.ts`

export type OrgUnitNode = {
  id: string;
  parentId: string | null;
  slug: string | null;
  name: string;
  /**
   * The `organizationPath` the registry says this unit should carry. Null when
   * the unit or an ancestor has no slug — an org_unit row predating the control
   * plane — so no path can be derived through it.
   */
  path: string | null;
  /** Segments below the tenant root; a top-level unit is 1. */
  depth: number;
  keycloakOrganizationId: string | null;
  createdAt: string;
  updatedAt: string;
  children: OrgUnitNode[];
};

export type OrgUnitTree = {
  tenant: {
    id: string;
    slug: string;
    name: string;
    status: string;
    keycloakOrganizationId: string | null;
  };
  roots: OrgUnitNode[];
  count: number;
  /** The depth cap the API enforces, so the UI can stop offering a child at the leaf. */
  maxDepth: number;
  truncated: boolean;
};

export type CreatedOrgUnit = {
  orgUnit: {
    id: string;
    tenantId: string;
    parentId: string | null;
    slug: string | null;
    name: string;
    keycloakOrganizationId: string | null;
  };
  organization: {
    id: string;
    alias: string;
    path: string;
    parentOrganizationId: string;
    rootOrganizationId: string;
  };
  created: boolean;
};

/** What a reparent did to one node's Keycloak Organization. */
export type OrgUnitProjection = {
  orgUnitId: string;
  path: string | null;
  organizationId: string | null;
  parentOrganizationId: string | null;
  applied: boolean;
  reason: string | null;
};

export type UpdatedOrgUnit = {
  orgUnit: {
    id: string;
    tenantId: string;
    parentId: string | null;
    slug: string | null;
    name: string;
    keycloakOrganizationId: string | null;
  };
  renamed: boolean;
  reparented: boolean;
  projections: OrgUnitProjection[];
};

export async function listOrgUnits(
  tenantSlug: string,
): Promise<ControlApiResult<OrgUnitTree>> {
  return request(`/tenants/${encodeURIComponent(tenantSlug)}/organizations`);
}

export async function createOrgUnit(
  tenantSlug: string,
  input: { slug: string; name: string; parentOrgUnitId?: string },
): Promise<ControlApiResult<CreatedOrgUnit>> {
  return request(`/tenants/${encodeURIComponent(tenantSlug)}/organizations`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Rename and/or reparent one sub-organisation.
 *
 * As with `updateTenant`, there is deliberately NO slug parameter — and here
 * the reason is different from the tenant's. A sub-org slug is not an alias and
 * not a URL key; it is the unit's `organizationPath` segment, so editing it
 * would move the path of the unit and of every descendant exactly as a reparent
 * does, without being one. The control surface refuses a body carrying `slug`;
 * this signature makes sending one impossible from here.
 *
 * `parentOrgUnitId: null` is a REQUEST — "move to the top level" — and is not
 * the same as omitting it. `JSON.stringify` preserves an explicit null, which
 * is what keeps the two distinguishable across the wire.
 */
export async function updateOrgUnit(
  tenantSlug: string,
  orgUnitId: string,
  update: { name?: string; parentOrgUnitId?: string | null },
): Promise<ControlApiResult<UpdatedOrgUnit>> {
  return request(
    `/tenants/${encodeURIComponent(tenantSlug)}/organizations/${encodeURIComponent(orgUnitId)}`,
    { method: "PATCH", body: JSON.stringify(update) },
  );
}

// ---------------------------------------------------------------------------
// Reconciliation, mirroring `apps/api/src/control/reconciliation.ts`

/**
 * The drift vocabulary. Mirrored as a plain union rather than imported, exactly
 * as `TENANT_STATUSES` is: this app does not depend on `apps/api`, and a code
 * this UI does not recognise still renders (the message is written for an
 * operator and is always present) instead of failing to compile.
 */
export type DriftCode =
  | "TENANT_ORGANIZATION_MISSING"
  | "ORG_UNIT_ORGANIZATION_MISSING"
  | "ORGANIZATION_ORPHANED"
  | "ORGANIZATION_ALIAS_MISMATCH"
  | "ORGANIZATION_LEVEL_MISMATCH"
  | "ORGANIZATION_PATH_MISMATCH"
  | "ORGANIZATION_PARENT_MISMATCH"
  | "ORGANIZATION_ROOT_MISMATCH"
  | "ORGANIZATION_ENABLED_MISMATCH"
  | "TARGET_NOT_PROJECTABLE";

export type DriftFinding = {
  code: DriftCode | (string & {});
  tenantSlug: string | null;
  tenantId: string | null;
  orgUnitId: string | null;
  organizationId: string | null;
  /** What the registry says. Null when the registry says "nothing". */
  expected: string | null;
  /** What Keycloak holds. Null when Keycloak holds nothing. */
  actual: string | null;
  /** False means a human has to decide; a re-apply will not touch it. */
  repairable: boolean;
  message: string;
};

export type DriftReport = {
  scannedAt: string;
  counts: { tenants: number; orgUnits: number; organizations: number };
  truncated: { tenants: boolean; orgUnits: boolean; organizations: boolean };
  /** False when a scan was truncated, so the orphan class was not evaluated. */
  orphansEvaluated: boolean;
  findings: DriftFinding[];
};

export type ReapplyAction = {
  target: "tenant" | "orgUnit";
  tenantSlug: string;
  orgUnitId: string | null;
  organizationId: string | null;
  path: string | null;
  applied: boolean;
  error: string | null;
};

export type ReapplyResult = {
  before: DriftReport;
  actions: ReapplyAction[];
  after: DriftReport;
  converged: boolean;
};

export async function getDriftReport(): Promise<ControlApiResult<DriftReport>> {
  return request("/reconciliation");
}

/**
 * Push registry state back into Keycloak.
 *
 * `tenantSlug` bounds the run to one tenant. Omitting it reconciles every tenant
 * that has a repairable finding — and a converged registry is a genuine no-op:
 * the API only touches tenants its own report named.
 */
export async function reapplyProjection(input: {
  tenantSlug?: string;
} = {}): Promise<ControlApiResult<ReapplyResult>> {
  return request("/reconciliation/reapply", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
