// SPDX-License-Identifier: BUSL-1.1
/**
 * The `osf-control` runtime module against its authored catalog: every
 * handler the catalog names exists and nothing else does; the domain
 * assertions run BEFORE any elevation; a service refusal is answered in the
 * Operation's declared vocabulary with the service's own code kept.
 *
 * No database: every case here is refused (or answered) before the system
 * session would open. The database path is covered by
 * db/__tests__/platform-control-operations.test.ts.
 */
import { describe, expect, it } from "bun:test";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import type { ModuleOperationContext, RuntimeModule } from "../../modules/contract.js";
import { bindOperationHandlers } from "../../operations/runtime.js";
import { ControlAuthorizationError } from "../authorization.js";
import { controlSessionFor } from "../control-session.js";
import { ControlServiceError } from "../errors.js";
import { FirstAdministratorError } from "../first-tenant-administrator.js";
import { KeycloakAdminError } from "../keycloak-organization-admin.js";
import { KeycloakSpiError } from "../keycloak-spi-client.js";
import {
  CONTROL_PLUGIN,
  ControlOperationError,
  controlOperationFailure,
  controlOperationHandler,
  controlOperationHandlerNames,
} from "../operations.js";
import { ControlInputError } from "../organization-naming.js";
import type { PlatformAdministrator } from "../platform-admin.js";
import { PlatformCatalogError } from "../platform-catalog.js";
import { PLATFORM_GUIDE } from "../platform-tools.js";
import type { ControlRuntime } from "../runtime.js";
import { controlOperationContract, controlOperationContracts } from "./control-operation-fixtures.js";

const administrator: PlatformAdministrator = {
  subject: "0b2a3f1e-8a6b-4f30-9d2f-5f1c7a8e9b10",
  issuer: "http://localhost:8181/realms/openshapeforge-control",
  username: "platform-admin",
  name: "Platform admin",
  email: "platform-admin@example.com",
  authorizedParty: "codex-platform",
  expiresAtMs: null,
};
const session = controlSessionFor(administrator, ["platform_admin", "platform-operator"]);

/** A database that would explode if touched: the point is that it is not. */
const untouchable = new Proxy({}, { get: () => { throw new Error("database touched"); } }) as never;

const unconfigured: ControlRuntime = {
  config: { ok: false, missing: ["OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL"] },
  provider: undefined,
  operations: controlOperationContracts(),
};

/** `null` means "none": an explicit undefined would select the default. */
function contextFor(
  active: TrustedSessionContext | null = session,
  runtime: ControlRuntime | null = unconfigured,
): ModuleOperationContext {
  return {
    db: untouchable,
    ...(runtime ? { control: runtime } : {}),
    ...(active ? { session: active } : {}),
    transport: "rest",
    invokeHostOperation: () => { throw new Error("not in this test"); },
    invokeDeclarativeService: () => { throw new Error("not in this test"); },
  };
}

async function refusal(
  handler: string,
  input: Record<string, unknown>,
  active: TrustedSessionContext | null = session,
  runtime: ControlRuntime | null = unconfigured,
) {
  const result = await controlOperationHandler(controlOperationContract(handler))(input, contextFor(active, runtime));
  if (!("ok" in result) || result.ok !== false) throw new Error(`expected a refusal from ${handler}`);
  const error = (result.body as { error: { code: string; message: string; detail?: string } }).error;
  // The body's code is the declared one, the same the result carries.
  expect(error.code).toBe(result.code);
  return { status: result.status, ...error };
}

describe("binding the control catalog", () => {
  it("has exactly one handler per authored handler name, and no extras", () => {
    const authored = controlOperationContracts().map((operation) => operation.handler).sort();
    expect(authored).toHaveLength(23);
    expect(controlOperationHandlerNames()).toEqual(authored);
  });

  it("binds all 23 in a process without any operation module, as core", () => {
    const bound = bindOperationHandlers([], controlOperationContracts());
    expect([...bound.keys()].sort()).toEqual(controlOperationContracts().map((operation) => operation.key).sort());
    expect([...bound.values()].every(({ operation }) => operation.plugin === CONTROL_PLUGIN)).toBe(true);
  });

  it("refuses a plugin that claims the core control runtime and a catalog naming a handler it lacks", () => {
    const impostor: RuntimeModule = { name: CONTROL_PLUGIN, operationHandlers: {} };
    expect(() => bindOperationHandlers([impostor], controlOperationContracts())).toThrow(
      "The core control runtime cannot be replaced by a plugin.",
    );
    expect(() => controlOperationHandler({ key: "control.drop-tenant", handler: "dropTenant" })).toThrow(
      'Unknown core control handler "dropTenant".',
    );
  });
});

describe("what a handler answers without a database", () => {
  it("returns the guide and refuses a session that is not a control-realm one", async () => {
    const guide = await controlOperationHandler(controlOperationContract("platformGuide"))({}, contextFor(session));
    expect(guide).toEqual({ value: { guide: PLATFORM_GUIDE } });
    const tenantSession = { ...session, credential: "bearer" as const, tenantId: "tenant-a" };
    expect(await refusal("platformGuide", {}, tenantSession)).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    expect(await refusal("platformGuide", {}, null)).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
  });

  it("answers CONTROL_PLANE_NOT_CONFIGURED naming what is missing, on the runtime and on the clients", async () => {
    const withoutRuntime = await controlOperationHandler(controlOperationContract("listTenants"))({}, contextFor(session, null));
    expect(withoutRuntime).toMatchObject({ ok: false, status: 503, code: "CONTROL_PLANE_NOT_CONFIGURED" });
    const missingKeycloak = await refusal("getTenantOrganizationTree", { slug: "acme" });
    expect(missingKeycloak).toMatchObject({ status: 503, code: "CONTROL_PLANE_NOT_CONFIGURED" });
    expect(missingKeycloak.message).toContain("OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL");
  });

  it("validates lifecycle and organization changes before opening an elevated session", async () => {
    expect(await refusal("createTenant", { slug: "Not valid", name: "Acme" })).toMatchObject({
      status: 400, code: "VALIDATION", detail: "CONTROL_INVALID_INPUT",
    });
    expect((await refusal("updateTenant", { slug: "acme" })).message).toContain("changes nothing");
    expect((await refusal("updateTenant", { slug: "acme", status: "deleted" })).message).toContain("status must be one of");
    expect((await refusal("updateTenantOrganization", { tenantSlug: "acme", orgUnitId: "not-a-uuid", name: "Sales" })).detail)
      .toBe("CONTROL_INVALID_INPUT");
    expect((await refusal("createTenantOrganization", { tenantSlug: "acme", slug: "sales", name: "Sales", parentOrgUnitId: "nope" })).message)
      .toContain("parentOrgUnitId must be a UUID");
    expect((await refusal("assignBlueprintLibrary", { slug: "acme", blueprintTenantSlug: 42 })).message)
      .toContain("tenant slug or null");
    expect((await refusal("reapplyReconciliation", { tenantSlug: "Bad Slug" })).code).toBe("VALIDATION");
  });

  it("validates catalog and audit arguments the schema cannot express", async () => {
    expect((await refusal("listPlatformAudit", { since: "2026-09-10T00:00:00Z", until: "2026-09-09T00:00:00Z" })).message)
      .toContain("earlier than until");
    expect((await refusal("listPlatformAudit", { limit: 201 })).message).toContain("1 through 200");
    expect((await refusal("listCatalogEntries", { limit: 0 })).message).toContain("limit");
    expect((await refusal("publishCatalogEntry", { kind: "service", key: "record-finding", definition: {}, authority: "vendor" })).message)
      .toContain("authority must be one of");
    expect((await refusal("publishCatalogEntry", { kind: "service", key: "record-finding", definition: "text" })).message)
      .toContain("definition must be a JSON object");
  });

  it("says when no module administers a catalog, as the conflict it is", async () => {
    expect(await refusal("listCatalogEntries", {})).toMatchObject({
      status: 409, code: "CONFLICT", detail: "PLATFORM_CATALOG_UNAVAILABLE",
    });
  });

  it("refuses a first-administrator invitation without the invitation clients, by name", async () => {
    expect(await refusal("inviteFirstTenantAdmin", { slug: "acme", email: "admin@example.com" })).toMatchObject({
      status: 503, code: "CONTROL_PLANE_NOT_CONFIGURED", detail: "INVITATIONS_NOT_CONFIGURED",
    });
    expect(await refusal("inviteFirstTenantAdmin", { slug: "acme", email: "invalid" })).toMatchObject({
      status: 400, code: "VALIDATION", detail: "INVALID_INPUT",
    });
  });

  it("lets an unclassified fault through, logged, so the runtime redacts it", async () => {
    const logged: unknown[] = [];
    const runtime: ControlRuntime = { ...unconfigured, log: (error) => logged.push(error) };
    await expect(
      controlOperationHandler(controlOperationContract("listTenants"))({}, contextFor(session, runtime)),
    ).rejects.toThrow("database touched");
    expect(logged).toHaveLength(1);
  });
});

describe("controlOperationFailure", () => {
  const detailOf = (error: unknown) => {
    const failure = controlOperationFailure(error);
    if (!failure) return undefined;
    const body = failure.body as { error: { code: string; message: string; detail?: string; data?: unknown } };
    expect(body.error.code).toBe(failure.code);
    return { status: failure.status, ...body.error };
  };

  it("maps every service class to the declared vocabulary and keeps the original code and message", () => {
    expect(detailOf(new ControlInputError("slug is required."))).toMatchObject({
      status: 400, code: "VALIDATION", detail: "CONTROL_INVALID_INPUT", message: "slug is required.",
    });
    expect(detailOf(new ControlAuthorizationError("UNAUTHENTICATED", "no token"))).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    expect(detailOf(new ControlAuthorizationError("FORBIDDEN", "no role"))).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(detailOf(new ControlAuthorizationError("CONTROL_PLANE_NOT_CONFIGURED", "missing"))).toMatchObject({
      status: 503, code: "CONTROL_PLANE_NOT_CONFIGURED",
    });
    expect(detailOf(new ControlServiceError("CONTROL_TENANT_NOT_FOUND", 'No tenant with slug "x".'))).toMatchObject({
      status: 404, code: "NOT_FOUND", detail: "CONTROL_TENANT_NOT_FOUND",
    });
    expect(detailOf(new ControlServiceError("CONTROL_ORG_UNIT_SLUG_TAKEN", "taken"))).toMatchObject({
      status: 409, code: "CONFLICT", detail: "CONTROL_ORG_UNIT_SLUG_TAKEN",
    });
    expect(detailOf(new PlatformCatalogError("CATALOG_INVALID_DEFINITION", "Not publishable.", ["name is required"]))).toMatchObject({
      status: 409, code: "CONFLICT", detail: "CATALOG_INVALID_DEFINITION", data: { problems: ["name is required"] },
    });
    expect(detailOf(new PlatformCatalogError("CATALOG_ENTRY_NOT_FOUND", "gone"))).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(detailOf(new PlatformCatalogError("CONTROL_INVALID_INPUT", "bad"))).toMatchObject({ status: 400, code: "VALIDATION" });
    expect(detailOf(new FirstAdministratorError("FIRST_ADMIN_ALREADY_ASSIGNED", "exists"))).toMatchObject({ status: 409, code: "CONFLICT" });
    expect(detailOf(new FirstAdministratorError("TENANT_NOT_FOUND", "gone"))).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(detailOf(new KeycloakAdminError("KEYCLOAK_ADMIN_UNAVAILABLE", "down", 503))).toMatchObject({
      status: 502, code: "IDENTITY_PROVIDER_ERROR", detail: "KEYCLOAK_ADMIN_UNAVAILABLE",
    });
    expect(detailOf(new KeycloakSpiError("KEYCLOAK_SPI_REJECTED", "no", 400))).toMatchObject({
      status: 502, code: "IDENTITY_PROVIDER_ERROR", detail: "KEYCLOAK_SPI_REJECTED",
    });
    expect(detailOf(new ControlOperationError(404, "NOT_FOUND", "UPDATE_NOTICE_NOT_FOUND", "gone"))).toMatchObject({
      status: 404, code: "NOT_FOUND", detail: "UPDATE_NOTICE_NOT_FOUND",
    });
    expect(detailOf(Object.assign(new Error("duplicate key"), { code: "23505" }))).toMatchObject({ status: 409, code: "CONFLICT", detail: "23505" });
  });

  it("classifies nothing else, so a driver error stays redacted", () => {
    expect(controlOperationFailure(new Error("select * from secret"))).toBeUndefined();
    expect(controlOperationFailure(Object.assign(new Error("x"), { code: "42P01" }))).toBeUndefined();
  });
});
