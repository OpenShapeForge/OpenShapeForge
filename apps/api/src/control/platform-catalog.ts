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
import { assertSlug } from "./organization-naming.js";
import {
  systemSessionForAdministrator,
  type PlatformAdministrator,
} from "./platform-admin.js";

// ── the module-side contract ────────────────────────────────────────────────
// Structural mirrors of the osf-integration plugin's `platformCatalog` export
// (packages/osf-integration/src/authoring/catalog-admin.ts). Kept as plain
// types so core never imports a plugin package.

export type CatalogKind = "adapter" | "capability" | "service";
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
  slug: string;
  name: string;
  status: string;
  /** The Keycloak Organization alias — the tenant slug — or null before provisioning linked one. */
  organizationAlias: string | null;
  installedEntries: number;
  overriddenEntries: number;
  updatesAvailable: number;
};

type TenantRow = {
  id: string;
  slug: string;
  name: string;
  status: string;
  keycloak_organization_id: string | null;
};

async function tenantRows(trx: Transaction<DB>): Promise<TenantRow[]> {
  const result = await sql<TenantRow>`
    select id::text as id, slug, name, status, keycloak_organization_id
      from platform.tenants
     order by slug
  `.execute(trx);
  return result.rows;
}

function toPlatformTenant(row: TenantRow, summary: TenantInstallationSummary | undefined): PlatformTenant {
  return {
    slug: row.slug,
    name: row.name,
    status: row.status,
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

/** Every tenant with its catalog installation counts. Empty counts without a provider. */
export async function listPlatformTenants(deps: PlatformCatalogDeps): Promise<PlatformTenant[]> {
  return elevated(deps, "list_tenants", async (trx) => {
    const rows = await tenantRows(trx);
    const summaries = deps.provider ? await deps.provider.installationSummary(trx) : [];
    const byTenant = new Map(summaries.map((summary) => [summary.tenantId, summary]));
    return rows.map((row) => toPlatformTenant(row, byTenant.get(row.id)));
  });
}

export async function getPlatformTenant(deps: PlatformCatalogDeps, slug: string): Promise<PlatformTenant> {
  assertSlug(slug, "slug");
  return elevated(deps, `get_tenant slug="${slug}"`, async (trx) => {
    const row = (await tenantRows(trx)).find((candidate) => candidate.slug === slug);
    if (!row) throw tenantNotFound(slug);
    const summary = deps.provider
      ? (await deps.provider.installationSummary(trx)).find((item) => item.tenantId === row.id)
      : undefined;
    return toPlatformTenant(row, summary);
  });
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
  return elevated(deps, "list_catalog_entries", async (trx) => {
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
  return elevated(deps, `get_catalog_entry ${kind}/${key}`, async (trx) => {
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
  return elevated(deps, `publish_catalog_entry ${input.kind}/${input.key}`, async (trx) => {
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
  return elevated(deps, `retire_catalog_entry ${kind}/${key}`, async (trx) => {
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
  return elevated(deps, `apply_catalog_update_for_tenant ${kind}/${key} tenant="${slug}"`, async (trx) => {
    const row = (await tenantRows(trx)).find((candidate) => candidate.slug === slug);
    if (!row) throw tenantNotFound(slug);
    const result = await provider.applyUpdateForTenant(trx, row.id, kind, key).catch(translate);
    return { ...result, tenant: slug };
  });
}
