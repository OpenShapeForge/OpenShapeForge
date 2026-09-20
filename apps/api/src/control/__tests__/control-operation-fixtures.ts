// SPDX-License-Identifier: BUSL-1.1
/**
 * The runtime contracts of the 23 `osf-control` Operations, as the compiler
 * lowers the authored catalog (`packages/compiler/config/authoring/
 * operations/control.yaml`): key = the authored `id`, `handler` = the
 * authored handler, `auth: { mode: control, roles }`, `tenancy: none`,
 * `natural` idempotency lowered to `intrinsic`, an `acknowledgement`
 * confirmation adding the platform's `confirmed` control field to the input
 * schema, REST from `interfaces.rest`, MCP names from `interfaces.mcp`,
 * GraphQL disabled, TypeScript enabled.
 *
 * Kept by hand, in sync with the YAML, so the runtime half is testable
 * before — and independently of — the compiled catalog: once the compiler
 * emits these, `catalog.operations` carries exactly what this builder
 * returns. Not a test file itself; it lives under `__tests__` so the
 * runner never collects it as one.
 */
import type { OperationContract } from "../../operations/runtime.js";

const ADMIN = "platform_admin";
const OPERATOR = "platform-operator";
const BOTH: readonly string[] = [ADMIN, OPERATOR];

const TENANCY = {
  mode: "none",
  description: "A platform operator acts across every tenant; no tenant context exists.",
} as const;

const ERRORS: OperationContract["errors"] = [
  { status: 400, code: "VALIDATION", description: "The input does not describe a valid request." },
  { status: 401, code: "UNAUTHENTICATED", description: "A control-realm operator token is required." },
  { status: 403, code: "FORBIDDEN", description: "The operator lacks a required control-realm role." },
  { status: 404, code: "NOT_FOUND", description: "The tenant, organization, entry or notice does not exist." },
  { status: 409, code: "CONFLICT", description: "The request contradicts the current platform state." },
  { status: 502, code: "IDENTITY_PROVIDER_ERROR", description: "The identity provider refused or failed the request." },
  { status: 503, code: "CONTROL_PLANE_NOT_CONFIGURED", description: "The control plane is not configured on this deployment." },
];

const READ = { data: "read", external: "none" } as const;
const READ_EXTERNAL = { data: "read", external: "read" } as const;
const WRITE = { data: "write", external: "none" } as const;
const WRITE_EXTERNAL = { data: "write", external: "write" } as const;

const slug = {
  type: "string",
  pattern: "^[a-z][a-z0-9-]*$",
  description: "The tenant's slug as list_tenants reports it (e.g. acme-dev).",
};
const kind = { type: "string", enum: ["service", "adapter", "capability"], description: "Catalog entry kind." };
const key = { type: "string", pattern: "^[a-z][a-z0-9-]*$", description: "Stable catalog key, kebab-case." };
const anyObject = { type: "object", additionalProperties: true };

/** The compiler's `withOperationControls` for an acknowledgement. */
const CONFIRMED = {
  type: "boolean",
  description: "Set to true after the user explicitly acknowledges this Operation.",
};

type Authored = {
  id: string;
  handler: string;
  title: string;
  description: string;
  roles: readonly string[];
  effects: NonNullable<OperationContract["effects"]>;
  idempotency: "natural" | "none";
  acknowledgement?: boolean;
  input?: { properties?: Record<string, unknown>; required?: string[] };
  output?: Record<string, unknown>;
  rest: { method: string; path: string; status: number };
  mcp: string;
};

const AUTHORED: readonly Authored[] = [
  {
    id: "control.whoami", handler: "whoami", title: "Who am I",
    description: "Describes the signed-in platform operator: name, role, scope (the whole platform), how many tenants exist and when the sign-in expires. Takes no arguments.",
    roles: BOTH, effects: READ, idempotency: "natural",
    output: { type: "object", additionalProperties: true, properties: { name: { type: "string" }, role: { type: "string" }, scope: { type: "string" }, tenants: { type: "integer" } } },
    rest: { method: "GET", path: "/api/control/v1/whoami", status: 200 }, mcp: "whoami",
  },
  {
    id: "control.platform-guide", handler: "platformGuide", title: "Platform administration guide",
    description: "The fixed process for administering the Service catalog: what an entry is, how a new version reaches tenants, when to force an update, how retirement behaves, and what never to do.",
    roles: BOTH, effects: READ, idempotency: "natural",
    output: { type: "object", additionalProperties: false, properties: { guide: { type: "string" } }, required: ["guide"] },
    rest: { method: "GET", path: "/api/control/v1/guide", status: 200 }, mcp: "platform_guide",
  },
  {
    id: "control.list-tenants", handler: "listTenants", title: "List tenants",
    description: "Every tenant of the deployment: slug, display name, lifecycle status, Keycloak organization alias, and how many catalog entries it has installed, overridden and pending. Never returns tenant data.",
    roles: BOTH, effects: READ, idempotency: "natural",
    // Mirrors control.yaml: the listing is a page with its total and cursor.
    output: {
      type: "object", additionalProperties: false,
      properties: { tenants: { type: "array", items: anyObject }, totalCount: { type: "integer", minimum: 0 }, nextCursor: { type: ["string", "null"] } },
      required: ["tenants", "totalCount", "nextCursor"],
    },
    rest: { method: "GET", path: "/api/control/v1/tenants", status: 200 }, mcp: "list_tenants",
  },
  {
    id: "control.get-tenant", handler: "getTenant", title: "Get tenant",
    description: "One tenant by slug with the same fields list_tenants shows.",
    roles: BOTH, effects: READ, idempotency: "natural",
    input: { properties: { slug }, required: ["slug"] },
    rest: { method: "GET", path: "/api/control/v1/tenants/:slug", status: 200 }, mcp: "get_tenant",
  },
  {
    id: "control.create-tenant", handler: "createTenant", title: "Create tenant",
    description: "Creates or safely replays ONE tenant in the platform registry and its root Keycloak Organization, then installs the current runtime catalog. Use a stable kebab-case slug and a human display name. A replay returns the existing tenant, repairs an incomplete Keycloak projection and installs missing catalog entries; it never deletes or replaces a tenant.",
    roles: [OPERATOR], effects: WRITE_EXTERNAL, idempotency: "natural",
    input: { properties: { slug, name: { type: "string", minLength: 1, description: "Human display name." } }, required: ["slug", "name"] },
    rest: { method: "POST", path: "/api/control/v1/tenants", status: 201 }, mcp: "create_tenant",
  },
  {
    id: "control.update-tenant", handler: "updateTenant", title: "Update tenant",
    description: "Renames ONE tenant and/or changes its lifecycle status. The slug stays immutable. Setting inactive or suspended disables the root Keycloak Organization and can interrupt access. Repeating the same state is a no-op.",
    roles: [OPERATOR], effects: WRITE_EXTERNAL, idempotency: "natural", acknowledgement: true,
    input: { properties: { slug, name: { type: "string", minLength: 1 }, status: { type: "string", enum: ["active", "inactive", "suspended"] } }, required: ["slug"] },
    rest: { method: "PATCH", path: "/api/control/v1/tenants/:slug", status: 200 }, mcp: "update_tenant",
  },
  {
    id: "control.get-blueprint-library", handler: "getBlueprintLibrary", title: "Get blueprint library",
    description: "Which tenant's published blueprints ONE tenant may copy from, or null when none is assigned.",
    roles: BOTH, effects: READ, idempotency: "natural",
    input: { properties: { slug }, required: ["slug"] },
    output: { type: "object", additionalProperties: true, properties: { tenant: { type: "string" }, blueprintTenant: { type: ["string", "null"] } }, required: ["tenant", "blueprintTenant"] },
    rest: { method: "GET", path: "/api/control/v1/tenants/:slug/blueprint-library", status: 200 }, mcp: "get_blueprint_library",
  },
  {
    id: "control.assign-blueprint-library", handler: "assignBlueprintLibrary", title: "Assign blueprint library",
    description: "Marks ONE active tenant as the blueprint library another tenant copies from. Pass null to clear the assignment. Existing copies keep their recorded source; a tenant cannot be its own library.",
    roles: [OPERATOR], effects: WRITE, idempotency: "natural",
    input: { properties: { slug, blueprintTenantSlug: { anyOf: [{ type: "string", pattern: "^[a-z][a-z0-9-]*$" }, { type: "null" }], description: "The library tenant's slug, or null to clear." } }, required: ["slug", "blueprintTenantSlug"] },
    output: { type: "object", additionalProperties: true, properties: { tenant: { type: "string" }, blueprintTenant: { type: ["string", "null"] }, changed: { type: "boolean" } }, required: ["tenant", "blueprintTenant", "changed"] },
    rest: { method: "PUT", path: "/api/control/v1/tenants/:slug/blueprint-library", status: 200 }, mcp: "assign_blueprint_library",
  },
  {
    id: "control.invite-first-tenant-admin", handler: "inviteFirstTenantAdmin", title: "Invite first tenant administrator",
    description: "Invites the first org_admin by email for ONE existing active tenant, through the Keycloak organization invitation flow. Repeating the same request reuses the invitation without resending. Refuses a different first administrator once one exists or is pending.",
    roles: [OPERATOR], effects: WRITE_EXTERNAL, idempotency: "natural", acknowledgement: true,
    input: { properties: { slug, email: { type: "string", format: "email" } }, required: ["slug", "email"] },
    rest: { method: "POST", path: "/api/control/v1/tenants/:slug/first-administrator", status: 200 }, mcp: "invite_first_tenant_admin",
  },
  {
    id: "control.list-tenant-invitations", handler: "listTenantInvitations", title: "List tenant invitations",
    description: "Lists outstanding invitations and unresolved pending role assignments for one tenant without returning invitation links.",
    roles: BOTH, effects: READ_EXTERNAL, idempotency: "natural",
    input: { properties: { slug }, required: ["slug"] },
    rest: { method: "GET", path: "/api/control/v1/tenants/:slug/invitations", status: 200 }, mcp: "list_tenant_invitations",
  },
  {
    id: "control.get-tenant-invitation", handler: "getTenantInvitation", title: "Get tenant invitation",
    description: "Reads safe metadata for one outstanding tenant invitation.", roles: BOTH, effects: READ_EXTERNAL, idempotency: "natural",
    input: { properties: { slug, invitationId: { type: "string" } }, required: ["slug", "invitationId"] },
    rest: { method: "GET", path: "/api/control/v1/tenants/:slug/invitations/:invitationId", status: 200 }, mcp: "get_tenant_invitation",
  },
  {
    id: "control.create-tenant-invitation", handler: "createTenantInvitation", title: "Create tenant invitation",
    description: "Invites one tenant member and records the selected allowlisted role.", roles: [OPERATOR], effects: WRITE_EXTERNAL, idempotency: "natural",
    input: { properties: { slug, email: { type: "string", format: "email" }, role: { type: "string", enum: ["org_admin", "org_employee"] }, firstName: { type: "string" }, lastName: { type: "string" } }, required: ["slug", "email", "role"] },
    rest: { method: "POST", path: "/api/control/v1/tenants/:slug/invitations", status: 201 }, mcp: "create_tenant_invitation",
  },
  {
    id: "control.revoke-tenant-invitation", handler: "revokeTenantInvitation", title: "Revoke tenant invitation",
    description: "Revokes an outstanding invitation and its pending role assignment without removing an accepted member.",
    roles: BOTH, effects: WRITE_EXTERNAL, idempotency: "natural", acknowledgement: true,
    input: { properties: { slug, invitationId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,128}$" } }, required: ["slug", "invitationId"] },
    rest: { method: "POST", path: "/api/control/v1/tenants/:slug/invitations/:invitationId/revoke", status: 200 }, mcp: "revoke_tenant_invitation",
  },
  {
    id: "control.resend-tenant-invitation", handler: "resendTenantInvitation", title: "Resend tenant invitation",
    description: "Explicitly resends an outstanding invitation while preserving its recipient and pending role.",
    roles: BOTH, effects: WRITE_EXTERNAL, idempotency: "none", acknowledgement: true,
    input: { properties: { slug, invitationId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,128}$" } }, required: ["slug", "invitationId"] },
    rest: { method: "POST", path: "/api/control/v1/tenants/:slug/invitations/:invitationId/resend", status: 200 }, mcp: "resend_tenant_invitation",
  },
  {
    id: "control.list-tenant-members", handler: "listTenantMembers", title: "List tenant members",
    description: "Lists members of one tenant organization with safe identity metadata.", roles: BOTH, effects: READ_EXTERNAL, idempotency: "natural",
    input: { properties: { slug }, required: ["slug"] }, rest: { method: "GET", path: "/api/control/v1/tenants/:slug/members", status: 200 }, mcp: "list_tenant_members",
  },
  {
    id: "control.get-tenant-member", handler: "getTenantMember", title: "Get tenant member",
    description: "Reads one verified tenant member.", roles: BOTH, effects: READ_EXTERNAL, idempotency: "natural",
    input: { properties: { slug, memberId: { type: "string" } }, required: ["slug", "memberId"] }, rest: { method: "GET", path: "/api/control/v1/tenants/:slug/members/:memberId", status: 200 }, mcp: "get_tenant_member",
  },
  ...(["assign", "remove"] as const).map((mode): Authored => ({
    id: `control.${mode}-tenant-member-roles`, handler: `${mode}TenantMemberRoles`, title: `${mode} tenant member roles`,
    description: `${mode} allowlisted roles for one verified tenant member.`, roles: [OPERATOR], effects: WRITE_EXTERNAL, idempotency: "natural", acknowledgement: true,
    input: { properties: { slug, memberId: { type: "string" }, roles: { type: "array", items: { type: "string", enum: ["org_admin", "org_employee"] } } }, required: ["slug", "memberId", "roles"] },
    rest: { method: "POST", path: `/api/control/v1/tenants/:slug/members/:memberId/roles/${mode}`, status: 200 }, mcp: `${mode}_tenant_member_roles`,
  })),
  {
    id: "control.remove-tenant-membership", handler: "removeTenantMembership", title: "Remove tenant membership",
    description: "Removes an organization membership without deleting the realm user.", roles: [OPERATOR], effects: WRITE_EXTERNAL, idempotency: "natural", acknowledgement: true,
    input: { properties: { slug, memberId: { type: "string" } }, required: ["slug", "memberId"] }, rest: { method: "DELETE", path: "/api/control/v1/tenants/:slug/members/:memberId", status: 200 }, mcp: "remove_tenant_membership",
  },
  {
    id: "control.request-passkey-recovery", handler: "requestPasskeyRecovery", title: "Request passkey recovery",
    description: "Sends the fixed passwordless WebAuthn registration action to one verified member.", roles: [OPERATOR], effects: WRITE_EXTERNAL, idempotency: "none", acknowledgement: true,
    input: { properties: { slug, memberId: { type: "string" } }, required: ["slug", "memberId"] }, rest: { method: "POST", path: "/api/control/v1/tenants/:slug/members/:memberId/passkey-recovery", status: 200 }, mcp: "request_passkey_recovery",
  },
  {
    id: "control.list-tenant-credentials", handler: "listTenantCredentials", title: "List member credentials",
    description: "Lists safe credential metadata for one verified member.", roles: BOTH, effects: READ_EXTERNAL, idempotency: "natural",
    input: { properties: { slug, memberId: { type: "string" } }, required: ["slug", "memberId"] }, rest: { method: "GET", path: "/api/control/v1/tenants/:slug/members/:memberId/credentials", status: 200 }, mcp: "list_tenant_credentials",
  },
  {
    id: "control.get-tenant-credential", handler: "getTenantCredential", title: "Get member credential",
    description: "Reads safe metadata for one credential.", roles: BOTH, effects: READ_EXTERNAL, idempotency: "natural",
    input: { properties: { slug, memberId: { type: "string" }, credentialId: { type: "string" } }, required: ["slug", "memberId", "credentialId"] }, rest: { method: "GET", path: "/api/control/v1/tenants/:slug/members/:memberId/credentials/:credentialId", status: 200 }, mcp: "get_tenant_credential",
  },
  {
    id: "control.revoke-tenant-credential", handler: "revokeTenantCredential", title: "Revoke member credential",
    description: "Revokes one credential with last-credential recovery protection.", roles: [OPERATOR], effects: WRITE_EXTERNAL, idempotency: "natural", acknowledgement: true,
    input: { properties: { slug, memberId: { type: "string" }, credentialId: { type: "string" }, recoveryConfirmed: { type: "boolean" } }, required: ["slug", "memberId", "credentialId", "recoveryConfirmed"] }, rest: { method: "DELETE", path: "/api/control/v1/tenants/:slug/members/:memberId/credentials/:credentialId", status: 200 }, mcp: "revoke_tenant_credential",
  },
  {
    id: "control.get-tenant-organization-tree", handler: "getTenantOrganizationTree", title: "Get organization tree",
    description: "The complete bounded sub-organization tree of ONE tenant beneath its Keycloak Organization, with the opaque org-unit ids used to create or move children. Never returns members or credentials.",
    roles: BOTH, effects: READ_EXTERNAL, idempotency: "natural",
    input: { properties: { slug }, required: ["slug"] },
    rest: { method: "GET", path: "/api/control/v1/tenants/:slug/organizations", status: 200 }, mcp: "get_tenant_organization_tree",
  },
  {
    id: "control.create-tenant-organization", handler: "createTenantOrganization", title: "Create organization",
    description: "Creates or safely replays ONE sub-organization beneath a tenant root or an explicit parent org unit, and provisions its Keycloak Organization and MCP audience scope.",
    roles: [OPERATOR], effects: WRITE_EXTERNAL, idempotency: "natural",
    input: { properties: { tenantSlug: slug, slug: { type: "string", pattern: "^[a-z][a-z0-9-]*$", description: "Immutable kebab-case path segment." }, name: { type: "string", minLength: 1, description: "Human display name." }, parentOrgUnitId: { type: "string", format: "uuid", description: "Opaque parent org-unit id; omit for the tenant root." } }, required: ["tenantSlug", "slug", "name"] },
    rest: { method: "POST", path: "/api/control/v1/tenants/:tenantSlug/organizations", status: 201 }, mcp: "create_tenant_organization",
  },
  {
    id: "control.update-tenant-organization", handler: "updateTenantOrganization", title: "Update organization",
    description: "Renames and/or reparents ONE existing sub-organization inside its tenant. Reparenting reprojects every descendant path in Keycloak and can affect access; null moves the unit directly beneath the tenant root.",
    roles: [OPERATOR], effects: WRITE_EXTERNAL, idempotency: "natural", acknowledgement: true,
    input: { properties: { tenantSlug: slug, orgUnitId: { type: "string", format: "uuid" }, name: { type: "string", minLength: 1 }, parentOrgUnitId: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }], description: "New parent id, or null for the tenant root; omit to keep the current parent." } }, required: ["tenantSlug", "orgUnitId"] },
    rest: { method: "PATCH", path: "/api/control/v1/tenants/:tenantSlug/organizations/:orgUnitId", status: 200 }, mcp: "update_tenant_organization",
  },
  {
    id: "control.get-reconciliation-report", handler: "getReconciliationReport", title: "Reconciliation report",
    description: "Compares the authoritative tenant and organization registry with its Keycloak projection and returns every bounded drift finding, including safe non-repairable ones. Inspect this before reapplying.",
    roles: BOTH, effects: READ_EXTERNAL, idempotency: "natural",
    rest: { method: "GET", path: "/api/control/v1/reconciliation", status: 200 }, mcp: "get_reconciliation_report",
  },
  {
    id: "control.reapply-reconciliation", handler: "reapplyReconciliation", title: "Reapply reconciliation",
    description: "Pushes authoritative registry state back into Keycloak for repairable drift, for ONE tenant slug or for every affected tenant when omitted. It never deletes unclaimed Organizations; replay may change identity access.",
    roles: [OPERATOR], effects: WRITE_EXTERNAL, idempotency: "natural", acknowledgement: true,
    input: { properties: { tenantSlug: slug } },
    rest: { method: "POST", path: "/api/control/v1/reconciliation/reapply", status: 200 }, mcp: "reapply_reconciliation",
  },
  {
    id: "control.list-platform-audit", handler: "listPlatformAudit", title: "Platform audit",
    description: "Recent audited platform actions, newest first: actor, time, action, target and result. Filter by exact actor or action, result and a time window; pass nextCursor back as cursor to continue. Never returns tokens, credentials or request bodies.",
    roles: [ADMIN], effects: READ, idempotency: "natural",
    input: { properties: { actor: { type: "string", description: "Exact audited actor subject." }, action: { type: "string", description: "Exact action name, such as publishCatalogEntry." }, result: { type: "string", enum: ["succeeded", "failed", "in_progress"] }, since: { type: "string", format: "date-time" }, until: { type: "string", format: "date-time" }, cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200, description: "Page size, default 50." } } },
    rest: { method: "GET", path: "/api/control/v1/audit", status: 200 }, mcp: "list_platform_audit",
  },
  {
    id: "control.list-catalog-entries", handler: "listCatalogEntries", title: "Service catalog",
    description: "The Service catalog, newest version per key, with per-tenant installation state: installed version, whether the tenant overrode it, and whether an update is pending. Filter by kind and/or key; paged.",
    roles: [ADMIN], effects: READ, idempotency: "natural",
    input: { properties: { kind, key, cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 } } },
    rest: { method: "GET", path: "/api/control/v1/catalog", status: 200 }, mcp: "list_catalog_entries",
  },
  {
    id: "control.get-catalog-entry", handler: "getCatalogEntry", title: "Get catalog entry",
    description: "One catalog entry by kind and key: its definition and every tenant's installation state.",
    roles: [ADMIN], effects: READ, idempotency: "natural",
    input: { properties: { kind, key }, required: ["kind", "key"] },
    rest: { method: "GET", path: "/api/control/v1/catalog/:kind/:key", status: 200 }, mcp: "get_catalog_entry",
  },
  {
    id: "control.publish-catalog-entry", handler: "publishCatalogEntry", title: "Publish catalog entry",
    description: "Publishes a new version of ONE catalog entry to every tenant: tenants that did not override it are updated, overridden tenants are flagged. There is no dry run; every tenant is affected.",
    roles: [ADMIN], effects: WRITE, idempotency: "none", acknowledgement: true,
    input: { properties: { kind, key, definition: { type: "object", additionalProperties: true, description: "The complete entry definition, exactly as the catalog stores it." }, authority: { type: "string", enum: ["platform", "tenant"], description: "Who owns changes after publication." } }, required: ["kind", "key", "definition"] },
    rest: { method: "POST", path: "/api/control/v1/catalog/:kind/:key/publish", status: 200 }, mcp: "publish_catalog_entry",
  },
  {
    id: "control.retire-catalog-entry", handler: "retireCatalogEntry", title: "Retire catalog entry",
    description: "Publishes a version marked retired: the Service becomes draft for every tenant that did not override it; overridden tenants are flagged and keep it until the update is applied.",
    roles: [ADMIN], effects: WRITE, idempotency: "none", acknowledgement: true,
    input: { properties: { kind, key }, required: ["kind", "key"] },
    rest: { method: "POST", path: "/api/control/v1/catalog/:kind/:key/retire", status: 200 }, mcp: "retire_catalog_entry",
  },
  {
    id: "control.apply-catalog-update-for-tenant", handler: "applyCatalogUpdateForTenant", title: "Apply catalog update for tenant",
    description: "Forces the latest published version of ONE entry onto ONE tenant that overrode it, discarding the tenant's override.",
    roles: [ADMIN], effects: WRITE, idempotency: "natural", acknowledgement: true,
    input: { properties: { slug, kind, key }, required: ["slug", "kind", "key"] },
    rest: { method: "POST", path: "/api/control/v1/tenants/:slug/catalog/:kind/:key/apply", status: 200 }, mcp: "apply_catalog_update_for_tenant",
  },
  {
    id: "control.publish-update-notice", handler: "publishUpdateNotice", title: "Publish update notice",
    description: "Tells everyone on this deployment what changed. Every person's assistant sees it once; serviceChanges brings each affected personal instruction up for review. Republishing a key replaces it for people not yet told.",
    roles: [ADMIN], effects: WRITE, idempotency: "natural",
    input: {
      properties: {
        key: { type: "string", pattern: "^[a-z][a-z0-9-]*$", description: "Stable notice key, kebab-case (e.g. day-start-v3)." },
        title: { type: "string", minLength: 1 },
        changed: { type: "string", minLength: 1, description: "What changed, for the assistant to put in the person's own words." },
        assistantChanges: { type: "array", items: { type: "string" }, description: "What an assistant now does differently. One sentence per entry." },
        userActions: { type: "array", items: { type: "object", additionalProperties: false, properties: { action: { type: "string" }, why: { type: "string" } }, required: ["action"] }, description: "Steps only the person can take." },
        serviceChanges: { type: "object", additionalProperties: { type: "string" }, description: "Catalog key of each changed Service mapped to what changed on it." },
      },
      required: ["key", "title", "changed"],
    },
    rest: { method: "POST", path: "/api/control/v1/notices", status: 201 }, mcp: "publish_update_notice",
  },
  {
    id: "control.list-update-notices", handler: "listUpdateNotices", title: "Update notices",
    description: "Every published update notice, newest first, with how many people have been told.",
    roles: [ADMIN], effects: READ, idempotency: "natural",
    rest: { method: "GET", path: "/api/control/v1/notices", status: 200 }, mcp: "list_update_notices",
  },
  {
    id: "control.withdraw-update-notice", handler: "withdrawUpdateNotice", title: "Withdraw update notice",
    description: "Withdraws ONE notice so nobody else is told; people already told keep their record.",
    roles: [ADMIN], effects: WRITE, idempotency: "natural",
    input: { properties: { key }, required: ["key"] },
    rest: { method: "POST", path: "/api/control/v1/notices/:key/withdraw", status: 200 }, mcp: "withdraw_update_notice",
  },
];

/** `control.list-tenants` → `controlListTenants`, the compiler's lowerCamel of an id. */
function lowerCamel(id: string): string {
  return id.split(/[.-]/).map((part, index) => index === 0 ? part : part[0]!.toUpperCase() + part.slice(1)).join("");
}

function contractOf(authored: Authored): OperationContract {
  const properties = { ...(authored.input?.properties ?? {}) };
  if (authored.acknowledgement) properties.confirmed = CONFIRMED;
  return {
    key: authored.id,
    intent: "invoke",
    plugin: "osf-control",
    title: authored.title,
    description: authored.description,
    handler: authored.handler,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties,
      ...(authored.input?.required ? { required: authored.input.required } : {}),
    },
    outputSchema: authored.output ?? anyObject,
    errors: ERRORS,
    auth: { mode: "control", roles: [...authored.roles] },
    tenancy: TENANCY,
    idempotency: { mode: authored.idempotency === "natural" ? "intrinsic" : "none" },
    effects: authored.effects,
    confirmation: { mode: authored.acknowledgement ? "acknowledgement" : "none" },
    transports: {
      rest: {
        method: authored.rest.method,
        path: authored.rest.path,
        response: { status: authored.rest.status, kind: "json" },
      },
      mcp: { enabled: true, name: authored.mcp },
      graphql: { enabled: false, reason: "The control catalog does not project to GraphQL." },
      typescript: { enabled: true, functionName: lowerCamel(authored.id) },
    },
  };
}

const CONTRACTS: readonly OperationContract[] = AUTHORED.map(contractOf);

/** The 23 contracts, in authored order. A fresh array per call; contracts are shared. */
export function controlOperationContracts(): OperationContract[] {
  return CONTRACTS.slice();
}

/** One contract by its authored handler name, for tests that address a single Operation. */
export function controlOperationContract(handler: string): OperationContract {
  const found = CONTRACTS.find((contract) => contract.handler === handler);
  if (!found) throw new Error(`No control Operation fixture has handler "${handler}".`);
  return found;
}
