// SPDX-License-Identifier: BUSL-1.1
/**
 * The core `osf-control` runtime module: one handler per Operation of the
 * platform's own administration, bound by `bindOperationHandlers` the way the
 * core blueprint handlers are (operations/runtime.ts).
 *
 * These used to be the platform administrator MCP's hand-written tools. As
 * canonical Operations they run on every transport — REST, `/admin/mcp`, the
 * generic `/api/operations` routes — through one runtime that has already
 * verified the control-realm session (`control-session.ts`), decided the role
 * (`auth.roles`), validated the input against the compiled schema and taken
 * the `confirmed` acknowledgement. What is left for a handler is the domain:
 * the assertions that mean something beyond a schema (a slug's length and
 * shape, `since` before `until`), the delegation to the audited control
 * services, and the answer.
 *
 * ELEVATION AND AUDIT. Nothing here touches the database directly. Every
 * service elevates itself with `withSystemSession` under the operator taken
 * from the session, and the audit reason names the Operation by its
 * canonical key (`platform-mcp: control.create-tenant create tenant
 * slug="acme"`), whichever transport carried the call. `platform-mcp` stays
 * the audit source label of the platform-administration surface: it is what
 * `list_platform_audit` selects on, and rows written before the cutover
 * carry it too.
 *
 * ERRORS. The services throw their own classes; the transports speak the
 * Operation's declared vocabulary. `controlOperationFailure` maps one onto
 * the other and keeps the service's code and message in the body, so a
 * client that used to branch on `CONTROL_TENANT_NOT_FOUND` still can, from
 * `error.detail`.
 */
import { randomUUID } from "node:crypto";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type {
  ModuleOperationErrorResult,
  ModuleOperationHandler,
} from "../modules/contract.js";
import type { OperationContract } from "../operations/runtime.js";
import { sessionOperationRolesAllow } from "../operations/session-authorization.js";
import { ControlAuthorizationError } from "./authorization.js";
import { type ControlSessionContext, isControlSession } from "./control-session.js";
import { ControlServiceError } from "./errors.js";
import {
  FirstAdministratorError,
  inviteFirstTenantAdministrator,
} from "./first-tenant-administrator.js";
import { manageTenantInvitations } from "./tenant-invitations.js";
import { KeycloakAdminError } from "./keycloak-organization-admin.js";
import { KeycloakSpiError } from "./keycloak-spi-client.js";
import { listOrgUnits, parseOrgUnitUpdate, updateOrgUnit } from "./org-unit-registry.js";
import { assertDisplayName, assertSlug, assertUuid, ControlInputError } from "./organization-naming.js";
import { listPlatformAudit } from "./platform-audit.js";
import {
  applyCatalogUpdateForTenant,
  type CatalogAuthority,
  type CatalogKind,
  getCatalogEntry,
  getPlatformTenant,
  listCatalogEntries,
  listPlatformTenants,
  type PlatformCatalogDeps,
  PlatformCatalogError,
  publishCatalogEntry,
  retireCatalogEntry,
} from "./platform-catalog.js";
import {
  buildPlatformSessionInfo,
  listPlatformTenantsCount,
  PLATFORM_GUIDE,
} from "./platform-tools.js";
import { provisionSubOrganization, provisionTenant } from "./provisioning.js";
import { buildDriftReport, reapplyProjection } from "./reconciliation.js";
import type { ControlRuntime } from "./runtime.js";
import {
  assignBlueprintLibrary,
  parseTenantUpdate,
  readBlueprintLibrary,
  updateTenant,
  type ControlDeps,
} from "./tenant-registry.js";
import {
  changeTenantMemberRoles,
  getTenantMember,
  getTenantCredential,
  listTenantCredentials,
  listTenantMembers,
  removeTenantMembership,
  requestPasskeyRecovery,
  revokeTenantCredential,
} from "./tenant-member-admin.js";
import {
  listUpdateNotices,
  publishUpdateNotice,
  validateUpdateNotice,
  withdrawUpdateNotice,
} from "./update-notices-admin.js";

/** The plugin name every control Operation is authored under. */
export const CONTROL_PLUGIN = "osf-control";

/** The audit source label shared by every control transport; see the module header. */
export const CONTROL_AUDIT_SOURCE = "platform-mcp" as const;

/** The authorities a catalog entry can be published under; `platform-catalog.ts` owns the meaning. */
const AUTHORITIES: readonly CatalogAuthority[] = ["platform_release", "host", "tenant_shared"];

type ControlHandlerContext = {
  /** The canonical Operation key — the audit action of every elevation this call makes. */
  operationKey: string;
  session: ControlSessionContext;
  db: OpenShapeForgeDatabase;
  runtime: ControlRuntime;
  log: (error: unknown) => void;
  /** Server-owned id correlating safe operator diagnostics to this call. */
  correlationId: string;
};

type ControlHandler = (
  input: Record<string, unknown>,
  context: ControlHandlerContext,
) => Promise<unknown>;

/**
 * A refusal a handler states in the Operation's own vocabulary, for the two
 * cases no service class covers: a state the service reports as `null`
 * (a notice that does not exist) and a process without a database.
 */
export class ControlOperationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** The finer-grained code kept in the body for a client that branches on it. */
    readonly detail: string,
    message: string,
  ) {
    super(message);
    this.name = "ControlOperationError";
  }
}

function catalogDeps(context: ControlHandlerContext): PlatformCatalogDeps {
  return {
    db: context.db,
    administrator: context.session.administrator,
    provider: context.runtime.provider,
  };
}

/**
 * The typed control services, or CONTROL_PLANE_NOT_CONFIGURED naming what is
 * missing. Checked here, per call, rather than at boot: an unconfigured
 * deployment must keep starting and keep answering the reads that need no
 * Keycloak (the guide, whoami, the catalog) by name.
 */
function controlDeps(context: ControlHandlerContext): ControlDeps {
  const { runtime } = context;
  if (!runtime.clients) {
    throw new ControlAuthorizationError(
      "CONTROL_PLANE_NOT_CONFIGURED",
      runtime.config.ok
        ? "Tenant and organization administration is not configured."
        : "The control plane is not configured. Missing environment: " +
          `${runtime.config.missing.join(", ")}.`,
    );
  }
  const { administrator } = context.session;
  return {
    db: context.db,
    ...runtime.clients.control,
    operator: {
      subject: administrator.subject,
      issuer: administrator.issuer,
      username: administrator.username,
      auditSource: CONTROL_AUDIT_SOURCE,
      auditAction: context.operationKey,
    },
  };
}

/**
 * The mutable fields exactly as sent, absent ones left absent. Read before the
 * control clients are asked for, so a request that changes nothing is refused
 * as such even on a deployment where the control plane is not configured.
 */
function pick(input: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]]),
  );
}

function requireSlug(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  assertSlug(value, field);
  return value;
}

function optionalString(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ControlInputError(`${field} must be a string.`);
  return value;
}

function requiredString(input: Record<string, unknown>, field: string): string {
  const value = optionalString(input, field);
  if (!value) throw new ControlInputError(`${field} is required.`);
  return value;
}

function memberDeps(context: ControlHandlerContext) {
  if (!context.runtime.clients?.identityMembers || !context.runtime.clients.memberRoles) throw new ControlAuthorizationError("CONTROL_PLANE_NOT_CONFIGURED", "Tenant identity administration is not configured.");
  return { db: context.db, administrator: context.session.administrator,
    members: context.runtime.clients.identityMembers, memberRoles: context.runtime.clients.memberRoles };
}

/** What whoami says a session can use when the transport did not say. */
function accessFromContracts(context: ControlHandlerContext): { tools: number; resources: number } {
  const tools = context.runtime.operations.filter((operation) =>
    operation.transports.mcp.enabled &&
    operation.auth.mode === "control" &&
    sessionOperationRolesAllow(operation.auth.roles, context.session.roles)
  ).length;
  // The platform-session resource is the one resource every control surface offers.
  return { tools, resources: 1 };
}

const HANDLERS: Readonly<Record<string, ControlHandler>> = {
  whoami: async (_input, context) => {
    const presentation = context.runtime.presentation;
    return buildPlatformSessionInfo({
      administrator: context.session.administrator,
      roles: context.session.roles,
      tenants: await listPlatformTenantsCount(catalogDeps(context)),
      client: presentation?.client ?? null,
      access: presentation ? presentation.access() : accessFromContracts(context),
    });
  },
  platformGuide: async () => ({ guide: PLATFORM_GUIDE }),
  listTenants: async (_input, context) => ({
    tenants: await listPlatformTenants(catalogDeps(context)),
  }),
  getTenant: (input, context) =>
    getPlatformTenant(catalogDeps(context), requireSlug(input, "slug")),
  createTenant: (input, context) => {
    const slug = requireSlug(input, "slug");
    const name = input.name;
    assertDisplayName(name, "name");
    return provisionTenant(controlDeps(context), { slug, name });
  },
  updateTenant: (input, context) => {
    const slug = requireSlug(input, "slug");
    const update = parseTenantUpdate(pick(input, ["name", "status"]));
    return updateTenant(controlDeps(context), slug, update);
  },
  getBlueprintLibrary: (input, context) =>
    readBlueprintLibrary(controlDeps(context), requireSlug(input, "slug")),
  assignBlueprintLibrary: (input, context) => {
    const slug = requireSlug(input, "slug");
    const library = input.blueprintTenantSlug;
    if (library !== null && typeof library !== "string") {
      throw new ControlInputError("blueprintTenantSlug must be a tenant slug or null.");
    }
    return assignBlueprintLibrary(controlDeps(context), slug, library);
  },
  inviteFirstTenantAdmin: (input, context) =>
    inviteFirstTenantAdministrator(
      {
        db: context.db,
        administrator: context.session.administrator,
        ...(context.runtime.clients
          ? { firstAdministrator: context.runtime.clients.firstAdministrator }
          : {}),
        log: context.log,
        correlationId: context.correlationId,
      },
      { slug: requireSlug(input, "slug"), email: String(input.email ?? "") },
    ),
  listTenantInvitations: (input, context) =>
    manageTenantInvitations(
      {
        db: context.db,
        administrator: context.session.administrator,
        ...(context.runtime.clients
          ? { firstAdministrator: context.runtime.clients.firstAdministrator }
          : {}),
        log: context.log,
        correlationId: context.correlationId,
      },
      "list",
      { slug: requireSlug(input, "slug") },
    ),
  getTenantInvitation: (input, context) =>
    manageTenantInvitations({ db: context.db, administrator: context.session.administrator,
      ...(context.runtime.clients ? { firstAdministrator: context.runtime.clients.firstAdministrator } : {}), log: context.log, correlationId: context.correlationId },
    "get", { slug: requireSlug(input, "slug"), invitationId: requiredString(input, "invitationId") }),
  createTenantInvitation: (input, context) => {
    const firstName = optionalString(input, "firstName");
    const lastName = optionalString(input, "lastName");
    return manageTenantInvitations({ db: context.db, administrator: context.session.administrator,
      ...(context.runtime.clients ? { firstAdministrator: context.runtime.clients.firstAdministrator } : {}), log: context.log, correlationId: context.correlationId },
    "create", { slug: requireSlug(input, "slug"), email: requiredString(input, "email"), role: requiredString(input, "role"),
      ...(firstName ? { firstName } : {}), ...(lastName ? { lastName } : {}) });
  },
  revokeTenantInvitation: (input, context) =>
    manageTenantInvitations(
      {
        db: context.db,
        administrator: context.session.administrator,
        ...(context.runtime.clients
          ? { firstAdministrator: context.runtime.clients.firstAdministrator }
          : {}),
        log: context.log,
        correlationId: context.correlationId,
      },
      "revoke",
      {
        slug: requireSlug(input, "slug"),
        invitationId: String(input.invitationId ?? ""),
      },
    ),
  resendTenantInvitation: (input, context) =>
    manageTenantInvitations(
      {
        db: context.db,
        administrator: context.session.administrator,
        ...(context.runtime.clients
          ? { firstAdministrator: context.runtime.clients.firstAdministrator }
          : {}),
        log: context.log,
        correlationId: context.correlationId,
      },
      "resend",
      {
        slug: requireSlug(input, "slug"),
        invitationId: String(input.invitationId ?? ""),
      },
    ),
  listTenantMembers: (input, context) => listTenantMembers(memberDeps(context), requireSlug(input, "slug")),
  getTenantMember: (input, context) => getTenantMember(memberDeps(context), requireSlug(input, "slug"), requiredString(input, "memberId")),
  assignTenantMemberRoles: (input, context) => changeTenantMemberRoles(memberDeps(context), requireSlug(input, "slug"), requiredString(input, "memberId"), input.roles, "assign"),
  removeTenantMemberRoles: (input, context) => changeTenantMemberRoles(memberDeps(context), requireSlug(input, "slug"), requiredString(input, "memberId"), input.roles, "remove"),
  removeTenantMembership: (input, context) => removeTenantMembership(memberDeps(context), requireSlug(input, "slug"), requiredString(input, "memberId")),
  requestPasskeyRecovery: (input, context) => requestPasskeyRecovery(memberDeps(context), requireSlug(input, "slug"), requiredString(input, "memberId")),
  listTenantCredentials: (input, context) => listTenantCredentials(memberDeps(context), requireSlug(input, "slug"), requiredString(input, "memberId")),
  getTenantCredential: (input, context) => getTenantCredential(memberDeps(context), requireSlug(input, "slug"), requiredString(input, "memberId"), requiredString(input, "credentialId")),
  revokeTenantCredential: (input, context) => revokeTenantCredential(memberDeps(context), requireSlug(input, "slug"), requiredString(input, "memberId"), requiredString(input, "credentialId"), input.recoveryConfirmed === true),
  getTenantOrganizationTree: (input, context) =>
    listOrgUnits(controlDeps(context), requireSlug(input, "slug")),
  createTenantOrganization: (input, context) => {
    const tenantSlug = requireSlug(input, "tenantSlug");
    const slug = requireSlug(input, "slug");
    const name = input.name;
    assertDisplayName(name, "name");
    if (input.parentOrgUnitId !== undefined) assertUuid(input.parentOrgUnitId, "parentOrgUnitId");
    return provisionSubOrganization(controlDeps(context), {
      tenantSlug,
      slug,
      name,
      ...(input.parentOrgUnitId === undefined
        ? {}
        : { parentOrgUnitId: input.parentOrgUnitId as string }),
    });
  },
  updateTenantOrganization: (input, context) => {
    const tenantSlug = requireSlug(input, "tenantSlug");
    const orgUnitId = input.orgUnitId;
    assertUuid(orgUnitId, "orgUnitId");
    const update = parseOrgUnitUpdate(pick(input, ["name", "parentOrgUnitId"]));
    return updateOrgUnit(controlDeps(context), tenantSlug, orgUnitId, update);
  },
  getReconciliationReport: (_input, context) => buildDriftReport(controlDeps(context)),
  reapplyReconciliation: (input, context) => {
    const tenantSlug = input.tenantSlug === undefined ? undefined : requireSlug(input, "tenantSlug");
    return reapplyProjection(controlDeps(context), {
      ...(tenantSlug === undefined ? {} : { tenantSlug }),
    });
  },
  listPlatformAudit: (input, context) => {
    // The schema settles shape and format; the window's order is the one
    // rule only the domain knows.
    const since = optionalString(input, "since");
    const until = optionalString(input, "until");
    if (since && until && Date.parse(since) >= Date.parse(until)) {
      throw new ControlInputError("since must be earlier than until.");
    }
    const actor = optionalString(input, "actor");
    const action = optionalString(input, "action");
    const cursor = optionalString(input, "cursor");
    const limit = input.limit;
    if (limit !== undefined && (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 200)) {
      throw new ControlInputError("limit must be an integer from 1 through 200.");
    }
    return listPlatformAudit(catalogDeps(context), {
      ...(actor ? { actor } : {}),
      ...(action ? { action } : {}),
      ...(input.result !== undefined
        ? { result: input.result as "succeeded" | "failed" | "in_progress" }
        : {}),
      ...(since ? { since: new Date(since).toISOString() } : {}),
      ...(until ? { until: new Date(until).toISOString() } : {}),
      ...(cursor ? { cursor } : {}),
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
    });
  },
  listCatalogEntries: (input, context) => {
    const kind = optionalString(input, "kind");
    const key = optionalString(input, "key");
    const cursor = optionalString(input, "cursor");
    const limit = input.limit;
    if (limit !== undefined && (!Number.isInteger(limit) || Number(limit) < 1)) {
      throw new ControlInputError("limit must be a positive integer.");
    }
    return listCatalogEntries(catalogDeps(context), {
      ...(kind !== undefined ? { kind: kind as CatalogKind } : {}),
      ...(key !== undefined ? { key } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
    });
  },
  getCatalogEntry: (input, context) =>
    getCatalogEntry(catalogDeps(context), String(input.kind), String(input.key)),
  publishCatalogEntry: (input, context) => {
    const definition = input.definition;
    if (definition === null || typeof definition !== "object" || Array.isArray(definition)) {
      throw new ControlInputError("definition must be a JSON object.");
    }
    const authority = optionalString(input, "authority");
    if (authority !== undefined && !AUTHORITIES.includes(authority as CatalogAuthority)) {
      throw new ControlInputError(`authority must be one of ${AUTHORITIES.join(", ")}.`);
    }
    return publishCatalogEntry(catalogDeps(context), {
      kind: input.kind as CatalogKind,
      key: String(input.key),
      definition: definition as Record<string, unknown>,
      ...(authority !== undefined ? { authority: authority as CatalogAuthority } : {}),
    });
  },
  retireCatalogEntry: (input, context) =>
    retireCatalogEntry(catalogDeps(context), String(input.kind), String(input.key)),
  applyCatalogUpdateForTenant: (input, context) =>
    applyCatalogUpdateForTenant(
      catalogDeps(context),
      requireSlug(input, "slug"),
      String(input.kind),
      String(input.key),
    ),
  // Shape only. Nothing here reads what the notice SAYS: the write right is
  // the restraint, not a filter on the text.
  publishUpdateNotice: (input, context) =>
    publishUpdateNotice(catalogDeps(context), validateUpdateNotice(input)),
  listUpdateNotices: async (_input, context) => ({
    notices: await listUpdateNotices(catalogDeps(context)),
  }),
  withdrawUpdateNotice: async (input, context) => {
    const key = String(input.key);
    const withdrawn = await withdrawUpdateNotice(catalogDeps(context), key);
    if (!withdrawn) {
      throw new ControlOperationError(
        404,
        "NOT_FOUND",
        "UPDATE_NOTICE_NOT_FOUND",
        `No update notice with key "${key}".`,
      );
    }
    return withdrawn;
  },
};

/** Every handler name this module binds, for the contract test against the catalog. */
export function controlOperationHandlerNames(): readonly string[] {
  return Object.keys(HANDLERS).sort();
}

function declaredFailure(
  status: number,
  code: string,
  source: { code: string; message: string; problems?: readonly string[] },
): ModuleOperationErrorResult {
  return {
    ok: false,
    status,
    code,
    body: {
      error: {
        code,
        message: source.message,
        retryable: false,
        detail: source.code,
        ...(source.problems && source.problems.length > 0
          ? { data: { problems: [...source.problems] } }
          : {}),
      },
    },
  };
}

/**
 * A control service's refusal in the Operation's declared vocabulary, or
 * undefined for a fault nobody classified — which the caller logs and lets
 * the runtime redact, because a driver error can carry SQL text.
 *
 * The finer code decides where a suffix says more than the class does: a
 * `*_NOT_FOUND` from any service is 404, `*_NOT_CONFIGURED` is the same 503
 * an unconfigured control plane answers, and a service's own INVALID_INPUT
 * is the 400 it is. Everything the identity provider refused or failed is
 * 502 — the operator is authorized; the deployment's service account or
 * Keycloak itself is what did not answer.
 */
export function controlOperationFailure(error: unknown): ModuleOperationErrorResult | undefined {
  if (error instanceof ControlOperationError) {
    return declaredFailure(error.status, error.code, { code: error.detail, message: error.message });
  }
  if (error instanceof ControlInputError) return declaredFailure(400, "VALIDATION", error);
  if (error instanceof ControlAuthorizationError) {
    const status = error.code === "FORBIDDEN" ? 403 : error.code === "UNAUTHENTICATED" ? 401 : 503;
    return declaredFailure(status, error.code, error);
  }
  if (
    error instanceof ControlServiceError ||
    error instanceof PlatformCatalogError ||
    error instanceof FirstAdministratorError
  ) {
    const problems = error instanceof PlatformCatalogError ? error.problems : undefined;
    const source = { code: error.code, message: error.message, ...(problems ? { problems } : {}) };
    if (error.code === "INVALID_INPUT" || error.code === "CONTROL_INVALID_INPUT") {
      return declaredFailure(400, "VALIDATION", source);
    }
    if (error.code.endsWith("_NOT_FOUND")) return declaredFailure(404, "NOT_FOUND", source);
    if (error.code.endsWith("_NOT_CONFIGURED")) {
      return declaredFailure(503, "CONTROL_PLANE_NOT_CONFIGURED", source);
    }
    return declaredFailure(409, "CONFLICT", source);
  }
  if (error instanceof KeycloakAdminError || error instanceof KeycloakSpiError) {
    return declaredFailure(502, "IDENTITY_PROVIDER_ERROR", error);
  }
  // Postgres unique_violation, the one SQLSTATE this surface provokes by
  // design (two tenants claiming one Organization, a concurrent identical
  // create losing the race): a real answer, named rather than redacted.
  if ((error as { code?: unknown } | null)?.code === "23505") {
    return declaredFailure(409, "CONFLICT", {
      code: "23505",
      message:
        "The requested identifier is already claimed by another row. " +
        "Reconcile the existing record instead of creating a second one.",
    });
  }
  return undefined;
}

/**
 * The runtime handler for one control Operation. Unknown handler names fail
 * at bind time, so a catalog naming a handler this module does not have
 * stops boot rather than answering 500 on its first call.
 */
export function controlOperationHandler(
  operation: Pick<OperationContract, "key" | "handler">,
): ModuleOperationHandler {
  const run = HANDLERS[operation.handler];
  if (!run) throw new Error(`Unknown core control handler "${operation.handler}".`);
  return async (input, context) => {
    const session = context.session;
    if (!isControlSession(session)) {
      // requireOperationAuthorization has already refused this; the handler
      // refuses it again so no transport can reach the services without it.
      return declaredFailure(401, "UNAUTHENTICATED", {
        code: "UNAUTHENTICATED",
        message: "A control-realm operator token is required.",
      });
    }
    const runtime = context.control;
    if (!runtime) {
      return declaredFailure(503, "CONTROL_PLANE_NOT_CONFIGURED", {
        code: "CONTROL_PLANE_NOT_CONFIGURED",
        message: "The control plane is not assembled in this process.",
      });
    }
    if (!context.db) {
      return declaredFailure(503, "CONTROL_PLANE_NOT_CONFIGURED", {
        code: "DATABASE_NOT_CONFIGURED",
        message: "The control plane has no database connection.",
      });
    }
    const log = runtime.log ?? (() => undefined);
    try {
      const value = await run(input, {
        operationKey: operation.key,
        session,
        db: context.db,
        runtime,
        log,
        correlationId: randomUUID(),
      });
      return { value };
    } catch (error) {
      const failure = controlOperationFailure(error);
      if (failure) return failure;
      log(error);
      throw error;
    }
  };
}
