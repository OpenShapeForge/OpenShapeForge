// SPDX-License-Identifier: BUSL-1.1
/**
 * The platform administrator's catalog operations, as the control plane runs
 * them: every one authenticated as a platform administrator, elevated to an
 * audited system session for exactly one call, and delegated to the runtime
 * module that owns the integration catalog.
 *
 * WHY THE CATALOG IS A MODULE'S, NOT CORE'S
 * -----------------------------------------
 * Core has no integration catalog. `integration.catalog_entries` and the
 * per-tenant installation columns are contributed by the osf-integration
 * plugin, and so are the rules — override classes, in-place update versus
 * flag, what "retired" does to a Service. Re-implementing those here would be
 * a second copy that drifts. So the module carries a small API
 * (`RuntimeModule.platformCatalog`, see modules/contract.ts) and this file is
 * the control plane's use of it: it supplies the cross-tenant session, maps
 * tenant ids to slugs — a tenant id never leaves the server — and turns the
 * module's refusals into codes the tool layer can present.
 *
 * WHY EVERY CALL IS A SYSTEM SESSION
 * ----------------------------------
 * The catalog table has no row policy, but the installation runs against
 * every tenant's `integration.*` rows, which do. `withSystemSession` is the
 * one way across that boundary, and it writes the audit row that makes a
 * platform-wide change reviewable: who (issuer-qualified), when, and which
 * tool on which key. Reads go through it as well, for the reason
 * tenant-registry.ts gives: a cross-tenant read is not a lesser act.
 */
import { sql, type Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withSystemSession } from "../db/session.js";
import type { DB } from "../generated/db/types.js";
import { tenantNotFound } from "./errors.js";
import { hostTenantFilter } from "./host-tenant-filter.js";
import { assertSlug, ControlInputError } from "./organization-naming.js";
import {
  systemSessionForAdministrator,
  type PlatformAdministrator,
} from "./platform-admin.js";

// ── the module-side contract ────────────────────────────────────────────────
// Structural mirrors of the osf-integration plugin's `platformCatalog` export
// (packages/osf-integration/src/authoring/catalog-admin.ts). Kept as plain
// types so core never imports a plugin package.

export type CatalogKind = "capability" | "adapter" | "service";
export type CatalogAuthority = "platform_release" | "host" | "tenant_shared";

export type CatalogTenantState = {
  tenantId: string;
  installedVersion: number;
  overridden: boolean;
  overrideFields: string[];
  updateAvailable: boolean;
  status: string | null;
};

export type CatalogEntrySummary = {
  kind: CatalogKind;
  key: string;
  latestVersion: number;
  authority: CatalogAuthority;
  source: string;
  publishedAt: string;
  retired: boolean;
  name: string | null;
  tenants: CatalogTenantState[];
};

export type CatalogEntryDetail = CatalogEntrySummary & {
  definition: Record<string, unknown>;
  versions: { version: number; publishedAt: string; source: string; retired: boolean }[];
};

export type TenantInstallOutcome = {
  tenantId: string;
  outcome: "installed" | "updated" | "flagged" | "unchanged" | "skipped" | "failed";
  error?: string;
};

export type PublishCatalogEntryResult = {
  kind: CatalogKind;
  key: string;
  version: number;
  previousVersion: number | null;
  authority: CatalogAuthority;
  source: string;
  retired: boolean;
  tenants: TenantInstallOutcome[];
};

export type ApplyCatalogUpdateResult = {
  kind: CatalogKind;
  key: string;
  previousVersion: number;
  appliedVersion: number;
  clearedOverrideFields: string[];
};

export type TenantInstallationSummary = {
  tenantId: string;
  installed: number;
  overridden: number;
  updatesAvailable: number;
};

export type TenantCatalogInstallResult = {
  tenantId: string;
  installed: number;
  updated: number;
  flagged: number;
  unchanged: number;
  skipped: number;
};

/**
 * What a runtime module supplies to administer its catalog. `db` is the
 * control plane's transaction (a Kysely `Transaction`, which the plugin
 * drives through `executeQuery`); the module must not open its own.
 */
export type PlatformCatalogProvider = {
  listEntries(
    db: unknown,
    options: { kind?: CatalogKind; key?: string; cursor?: string; limit?: number },
  ): Promise<{ entries: CatalogEntrySummary[]; nextCursor: string | null }>;
  getEntry(db: unknown, kind: string, key: string): Promise<CatalogEntryDetail>;
  publish(
    db: unknown,
    input: {
      kind: CatalogKind;
      key: string;
      definition: Record<string, unknown>;
      authority?: CatalogAuthority;
      source?: string;
    },
  ): Promise<PublishCatalogEntryResult>;
  retire(db: unknown, kind: string, key: string): Promise<PublishCatalogEntryResult>;
  applyUpdateForTenant(
    db: unknown,
    tenantId: string,
    kind: string,
    key: string,
  ): Promise<ApplyCatalogUpdateResult>;
  installForTenant(db: unknown, tenantId: string): Promise<TenantCatalogInstallResult>;
  installationSummary(db: unknown): Promise<TenantInstallationSummary[]>;
};

// ── errors ──────────────────────────────────────────────────────────────────

export type PlatformCatalogErrorCode =
  | "PLATFORM_CATALOG_UNAVAILABLE"
  | "CONTROL_INVALID_INPUT"
  | "CATALOG_INVALID_DEFINITION"
  | "CATALOG_ENTRY_NOT_FOUND"
  | "CATALOG_UNCHANGED"
  | "CATALOG_NOT_INSTALLED"
  | "CATALOG_UPDATE_FAILED";

export class PlatformCatalogError extends Error {
  readonly code: PlatformCatalogErrorCode;
  readonly problems: readonly string[];
  constructor(code: PlatformCatalogErrorCode, message: string, problems: readonly string[] = []) {
    super(message);
    this.name = "PlatformCatalogError";
    this.code = code;
    this.problems = problems;
  }
}

/**
 * The module's `CatalogAdminError` (recognised by name and `code`, since the
 * class is the plugin's) as a control-plane code. Anything else is rethrown:
 * a driver error is redacted by the tool layer like every other fault.
 */
function translate(error: unknown): never {
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown; problems?: unknown };
  if (candidate?.name === "CatalogAdminError" && typeof candidate.code === "string") {
    const message = typeof candidate.message === "string" ? candidate.message : "Refused.";
    const problems = Array.isArray(candidate.problems)
      ? candidate.problems.filter((item): item is string => typeof item === "string")
      : [];
    const byCode: Record<string, PlatformCatalogErrorCode> = {
      INVALID_INPUT: "CONTROL_INVALID_INPUT",
      INVALID_DEFINITION: "CATALOG_INVALID_DEFINITION",
      NOT_FOUND: "CATALOG_ENTRY_NOT_FOUND",
      UNCHANGED: "CATALOG_UNCHANGED",
      NOT_INSTALLED: "CATALOG_NOT_INSTALLED",
      UPDATE_FAILED: "CATALOG_UPDATE_FAILED",
    };
    throw new PlatformCatalogError(byCode[candidate.code] ?? "CONTROL_INVALID_INPUT", message, problems);
  }
  throw error;
}

// ── tenants, by slug ────────────────────────────────────────────────────────

export type PlatformTenant = {
  id: string;
  slug: string;
  name: string;
  status: string;
  tenantKind: "standard" | "blueprint";
  relationId: string | null;
  relationLabel: string | null;
  keycloakOrganizationId: string | null;
  /** The Keycloak Organization alias — the tenant slug — or null before provisioning linked one. */
  organizationAlias: string | null;
  installedEntries: number;
  overriddenEntries: number;
  updatesAvailable: number;
};

const PLATFORM_TENANT_QUERY_FIELDS = [
  "name", "slug", "status", "tenantKind", "organizationAlias", "relationLabel",
] as const;
type PlatformTenantQueryField = typeof PLATFORM_TENANT_QUERY_FIELDS[number];
export type PlatformTenantListInput = Partial<Record<PlatformTenantQueryField, string>> & {
  sortField?: PlatformTenantQueryField;
  sortDirection?: "asc" | "desc";
  first?: number;
  after?: string;
};
export type PlatformTenantPage = {
  tenants: PlatformTenant[];
  totalCount: number;
  nextCursor: string | null;
};

function tenantCursorOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const offset = /^\d+$/.test(decoded) ? Number(decoded) : Number.NaN;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) {
    throw new ControlInputError("after must be a nextCursor returned by the tenant listing.");
  }
  return offset;
}

function tenantCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function tenantQueryValue(tenant: PlatformTenant, field: PlatformTenantQueryField): string | null {
  const value = tenant[field];
  return value === null ? null : String(value);
}

function platformTenantListInput(input: Record<string, unknown>): Required<Pick<PlatformTenantListInput, "sortField" | "sortDirection" | "first">>
  & PlatformTenantListInput {
  const sortField = input.sortField ?? "slug";
  const sortDirection = input.sortDirection ?? "asc";
  const first = input.first ?? 50;
  if (typeof sortField !== "string" || !PLATFORM_TENANT_QUERY_FIELDS.includes(sortField as PlatformTenantQueryField)) {
    throw new ControlInputError(`sortField must be one of ${PLATFORM_TENANT_QUERY_FIELDS.join(", ")}.`);
  }
  if (sortDirection !== "asc" && sortDirection !== "desc") {
    throw new ControlInputError("sortDirection must be asc or desc.");
  }
  if (!Number.isInteger(first) || Number(first) < 1 || Number(first) > 100) {
    throw new ControlInputError("first must be an integer from 1 through 100.");
  }
  const result: PlatformTenantListInput = {
    sortField: sortField as PlatformTenantQueryField,
    sortDirection,
    first: Number(first),
  };
  if (input.after !== undefined) {
    if (typeof input.after !== "string") throw new ControlInputError("after must be a string.");
    result.after = input.after;
  }
  for (const field of PLATFORM_TENANT_QUERY_FIELDS) {
    const value = input[field];
    if (value === undefined || value === "") continue;
    if (typeof value !== "string") throw new ControlInputError(`${field} must be a string.`);
    result[field] = value;
  }
  return result as Required<Pick<PlatformTenantListInput, "sortField" | "sortDirection" | "first">> & PlatformTenantListInput;
}

/** Apply the list Operation's public query contract to already-authorized tenant summaries. */
export function queryPlatformTenants(
  tenants: readonly PlatformTenant[],
  rawInput: Record<string, unknown> = {},
): PlatformTenantPage {
  const input = platformTenantListInput(rawInput);
  const filtered = tenants.filter((tenant) => PLATFORM_TENANT_QUERY_FIELDS.every((field) => {
    const query = input[field]?.trim().toLocaleLowerCase("en");
    if (!query) return true;
    return tenantQueryValue(tenant, field)?.toLocaleLowerCase("en").includes(query) ?? false;
  }));
  const direction = input.sortDirection === "desc" ? -1 : 1;
  const sorted = [...filtered].sort((left, right) => {
    const leftValue = tenantQueryValue(left, input.sortField);
    const rightValue = tenantQueryValue(right, input.sortField);
    if (leftValue === null || rightValue === null) {
      if (leftValue === rightValue) return left.slug.localeCompare(right.slug, "en");
      return leftValue === null ? 1 : -1;
    }
    const ordered = leftValue.localeCompare(rightValue, "en", { sensitivity: "base", numeric: true });
    return ordered === 0 ? left.slug.localeCompare(right.slug, "en") : ordered * direction;
  });
  const offset = tenantCursorOffset(input.after);
  if (offset > sorted.length) throw new ControlInputError("after points beyond the filtered tenant listing.");
  const tenantsPage = sorted.slice(offset, offset + input.first);
  const nextOffset = offset + tenantsPage.length;
  return {
    tenants: tenantsPage,
    totalCount: sorted.length,
    nextCursor: nextOffset < sorted.length ? tenantCursor(nextOffset) : null,
  };
}

type TenantRow = {
  id: string;
  slug: string;
  name: string;
  status: string;
  keycloak_organization_id: string | null;
  relation_id: string | null;
  relation_label: string | null;
  blueprint_tenant: boolean;
};

async function tenantRows(trx: Transaction<DB>): Promise<TenantRow[]> {
  const result = await sql<TenantRow>`
    select tenant.id::text as id, tenant.slug, tenant.name, tenant.status,
           tenant.keycloak_organization_id, tenant.relation_id::text as relation_id,
           relation.display_name as relation_label,
           exists (
             select 1 from platform.blueprint_libraries source
              where source.blueprint_tenant_id = tenant.id
           ) as blueprint_tenant
      from platform.tenants tenant
      left join erp.relations relation
        on relation.id = tenant.relation_id and relation.tenant_id = tenant.id
     where ${hostTenantFilter("tenant.keycloak_realm")}
     order by tenant.slug
  `.execute(trx);
  return result.rows;
}

function toPlatformTenant(row: TenantRow, summary: TenantInstallationSummary | undefined): PlatformTenant {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    tenantKind: row.blueprint_tenant ? "blueprint" : "standard",
    relationId: row.relation_id,
    relationLabel: row.relation_label,
    keycloakOrganizationId: row.keycloak_organization_id,
    organizationAlias: row.keycloak_organization_id ? row.slug : null,
    installedEntries: summary?.installed ?? 0,
    overriddenEntries: summary?.overridden ?? 0,
    updatesAvailable: summary?.updatesAvailable ?? 0,
  };
}

export type PlatformCatalogDeps = {
  db: OpenShapeForgeDatabase;
  administrator: PlatformAdministrator;
  /** Absent when no loaded module administers a catalog. */
  provider: PlatformCatalogProvider | undefined;
};

function requireProvider(deps: PlatformCatalogDeps): PlatformCatalogProvider {
  if (!deps.provider) {
    throw new PlatformCatalogError(
      "PLATFORM_CATALOG_UNAVAILABLE",
      "No loaded runtime module administers an integration catalog on this deployment.",
    );
  }
  return deps.provider;
}

function elevated<T>(
  deps: PlatformCatalogDeps,
  reason: string,
  work: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  return withSystemSession(deps.db, systemSessionForAdministrator(deps.administrator, reason), work);
}

/** Every authorized tenant page with its catalog installation counts. Empty counts without a provider. */
export async function listPlatformTenants(
  deps: PlatformCatalogDeps,
  input: Record<string, unknown> = {},
): Promise<PlatformTenantPage> {
  return elevated(deps, "control.list-tenants", async (trx) => {
    const rows = await tenantRows(trx);
    const summaries = deps.provider ? await deps.provider.installationSummary(trx) : [];
    const byTenant = new Map(summaries.map((summary) => [summary.tenantId, summary]));
    return queryPlatformTenants(rows.map((row) => toPlatformTenant(row, byTenant.get(row.id))), input);
  });
}

export async function getPlatformTenant(deps: PlatformCatalogDeps, slug: string): Promise<PlatformTenant> {
  assertSlug(slug, "slug");
  return elevated(deps, `control.get-tenant slug="${slug}"`, async (trx) => {
    const row = (await tenantRows(trx)).find((candidate) => candidate.slug === slug);
    if (!row) throw tenantNotFound(slug);
    const summary = deps.provider
      ? (await deps.provider.installationSummary(trx)).find((item) => item.tenantId === row.id)
      : undefined;
    return toPlatformTenant(row, summary);
  });
}

/**
 * Project the loaded module's current catalog into one tenant. Provider
 * absence is a supported deployment shape, so tenant provisioning remains
 * available when no runtime module owns a catalog.
 */
export async function installCurrentCatalogForTenant(
  deps: PlatformCatalogDeps,
  slug: string,
  tenantId: string,
): Promise<TenantCatalogInstallResult | null> {
  if (!deps.provider) return null;
  assertSlug(slug, "slug");
  return elevated(deps, `control.create-tenant install current catalog tenant="${slug}"`, (trx) =>
    deps.provider!.installForTenant(trx, tenantId),
  );
}

// ── the catalog, with tenants named by slug ─────────────────────────────────

export type CatalogTenantView = Omit<CatalogTenantState, "tenantId"> & { tenant: string };
export type CatalogEntryView = Omit<CatalogEntrySummary, "tenants"> & { tenants: CatalogTenantView[] };
export type CatalogEntryDetailView = Omit<CatalogEntryDetail, "tenants"> & { tenants: CatalogTenantView[] };
export type TenantOutcomeView = Omit<TenantInstallOutcome, "tenantId"> & { tenant: string };
export type PublishView = Omit<PublishCatalogEntryResult, "tenants"> & { tenants: TenantOutcomeView[] };

function slugsOf(rows: readonly TenantRow[]): Map<string, string> {
  return new Map(rows.map((row) => [row.id, row.slug]));
}

function viewOf<T extends { tenantId: string }>(
  slugs: Map<string, string>,
  items: readonly T[],
): (Omit<T, "tenantId"> & { tenant: string })[] {
  return items.map(({ tenantId, ...rest }) => ({
    ...rest,
    // An id with no registry row cannot happen (installation rows reference a
    // tenant), but naming it would leak an id, so it is masked either way.
    tenant: slugs.get(tenantId) ?? "unknown-tenant",
  }));
}

export async function listCatalogEntries(
  deps: PlatformCatalogDeps,
  options: { kind?: CatalogKind; key?: string; cursor?: string; limit?: number },
): Promise<{ entries: CatalogEntryView[]; nextCursor: string | null }> {
  const provider = requireProvider(deps);
  return elevated(deps, "control.list-catalog-entries", async (trx) => {
    const slugs = slugsOf(await tenantRows(trx));
    const page = await provider.listEntries(trx, options).catch(translate);
    return {
      entries: page.entries.map((entry) => ({ ...entry, tenants: viewOf(slugs, entry.tenants) })),
      nextCursor: page.nextCursor,
    };
  });
}

export async function getCatalogEntry(
  deps: PlatformCatalogDeps,
  kind: string,
  key: string,
): Promise<CatalogEntryDetailView> {
  const provider = requireProvider(deps);
  return elevated(deps, `control.get-catalog-entry ${kind}/${key}`, async (trx) => {
    const slugs = slugsOf(await tenantRows(trx));
    const entry = await provider.getEntry(trx, kind, key).catch(translate);
    return { ...entry, tenants: viewOf(slugs, entry.tenants) };
  });
}

export async function publishCatalogEntry(
  deps: PlatformCatalogDeps,
  input: {
    kind: CatalogKind;
    key: string;
    definition: Record<string, unknown>;
    authority?: CatalogAuthority;
  },
): Promise<PublishView> {
  const provider = requireProvider(deps);
  return elevated(deps, `control.publish-catalog-entry ${input.kind}/${input.key}`, async (trx) => {
    const slugs = slugsOf(await tenantRows(trx));
    const result = await provider.publish(trx, input).catch(translate);
    return { ...result, tenants: viewOf(slugs, result.tenants) };
  });
}

export async function retireCatalogEntry(
  deps: PlatformCatalogDeps,
  kind: string,
  key: string,
): Promise<PublishView> {
  const provider = requireProvider(deps);
  return elevated(deps, `control.retire-catalog-entry ${kind}/${key}`, async (trx) => {
    const slugs = slugsOf(await tenantRows(trx));
    const result = await provider.retire(trx, kind, key).catch(translate);
    return { ...result, tenants: viewOf(slugs, result.tenants) };
  });
}

export async function applyCatalogUpdateForTenant(
  deps: PlatformCatalogDeps,
  slug: string,
  kind: string,
  key: string,
): Promise<ApplyCatalogUpdateResult & { tenant: string }> {
  const provider = requireProvider(deps);
  assertSlug(slug, "slug");
  return elevated(deps, `control.apply-catalog-update-for-tenant ${kind}/${key} tenant="${slug}"`, async (trx) => {
    const row = (await tenantRows(trx)).find((candidate) => candidate.slug === slug);
    if (!row) throw tenantNotFound(slug);
    const result = await provider.applyUpdateForTenant(trx, row.id, kind, key).catch(translate);
    return { ...result, tenant: slug };
  });
}
