// SPDX-License-Identifier: BUSL-1.1
/**
 * The control credential in the operations runtime: a control Operation
 * takes a control-realm session and nothing else, a session Operation takes
 * anything but one, and the tenant MCP never advertises a control tool.
 */
import { describe, expect, test } from "bun:test";
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from "kysely";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { controlSessionFor } from "../control/control-session.js";
import { controlOperationContract, controlOperationContracts } from "../control/__tests__/control-operation-fixtures.js";
import type { DB } from "../generated/db/types.js";
import { __operationMayInvokeForTests } from "../mcp/generated-mcp-server.js";
import { HttpError } from "../rest/http-error.js";
import { requireOperationAuthorization, runtimeStaticOperationRegistrations, type OperationContract } from "./runtime.js";

const administrator = {
  subject: "0b2a3f1e-8a6b-4f30-9d2f-5f1c7a8e9b10",
  issuer: "http://localhost:8181/realms/openshapeforge-control",
  username: "platform-admin",
  name: "Platform admin",
  email: null,
  authorizedParty: "codex-platform",
  expiresAtMs: null,
};
const admin = controlSessionFor(administrator, ["platform_admin"]);
const operator = controlSessionFor(administrator, ["platform-operator"]);
const tenant: TrustedSessionContext = {
  tenantId: "tenant-a",
  userId: "user-a",
  // Role names that happen to collide with the control realm's must not help.
  roles: ["platform_admin", "platform-operator", "workflow-admin"],
  groups: [],
  scope: "tenant",
  credential: "bearer",
};

const sessionOperation: OperationContract = {
  ...controlOperationContract("listTenants"),
  key: "workflow.instance.list",
  plugin: "workflow",
  auth: { mode: "session", roles: ["workflow-admin"] },
  tenancy: { mode: "required" },
};

const status = (operation: OperationContract, session: TrustedSessionContext | undefined) => {
  try {
    requireOperationAuthorization(operation, session);
    return 200;
  } catch (error) {
    return (error as HttpError).status;
  }
};

describe("requireOperationAuthorization with the control credential", () => {
  test("a control Operation admits a control session holding one of its roles", () => {
    expect(status(controlOperationContract("listTenants"), admin)).toBe(200);
    expect(status(controlOperationContract("listTenants"), operator)).toBe(200);
    expect(status(controlOperationContract("createTenant"), operator)).toBe(200);
    // Registry reads are shared, but tenant lifecycle mutations belong to the operator.
    expect(status(controlOperationContract("createTenant"), admin)).toBe(403);
    expect(status(controlOperationContract("listCatalogEntries"), admin)).toBe(200);
    // The catalog is platform_admin's; the operator role does not imply it.
    expect(status(controlOperationContract("listCatalogEntries"), operator)).toBe(403);
  });

  test("a tenant session never satisfies a control Operation, with the same 401 as no session", () => {
    expect(status(controlOperationContract("listTenants"), tenant)).toBe(401);
    expect(status(controlOperationContract("listTenants"), undefined)).toBe(401);
    expect(status(controlOperationContract("listTenants"), { ...tenant, credential: "api-key" })).toBe(401);
    expect(status(controlOperationContract("listTenants"), { ...tenant, credential: "trusted-context" })).toBe(401);
  });

  test("a control session never satisfies a session Operation, whatever it is called", () => {
    expect(status(sessionOperation, tenant)).toBe(200);
    expect(status(sessionOperation, { ...tenant, roles: ["reader"] })).toBe(403);
    expect(status(sessionOperation, controlSessionFor(administrator, ["workflow-admin"]))).toBe(401);
    expect(status(sessionOperation, admin)).toBe(401);
  });

  test("the runtime registry offers each control Operation to exactly the sessions its roles admit", () => {
    const db = new Kysely<DB>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (database) => new PostgresIntrospector(database),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
    const registrations = runtimeStaticOperationRegistrations([], { db }, controlOperationContracts());
    expect(registrations).toHaveLength(23);
    const availableTo = (session: TrustedSessionContext) =>
      registrations.filter((registration) => registration.available(session)).map((registration) => registration.definition.id);
    expect(availableTo(admin)).toEqual(
      controlOperationContracts()
        .filter((operation) => operation.auth.mode === "control" && operation.auth.roles.includes("platform_admin"))
        .map((operation) => operation.key),
    );
    expect(availableTo(admin)).not.toContain("control.create-tenant");
    expect(availableTo(operator)).toEqual(
      controlOperationContracts()
        .filter((operation) => operation.auth.mode === "control" && operation.auth.roles.includes("platform-operator"))
        .map((operation) => operation.key),
    );
    expect(availableTo(tenant)).toEqual([]);
  });
});

describe("the tenant MCP", () => {
  test("never advertises a control tool, to any session", () => {
    const controlTool = {
      key: "control.list-tenants",
      plugin: "osf-control",
      name: "list_tenants",
      title: "List tenants",
      description: "",
      inputSchema: {},
      outputSchema: {},
      auth: { mode: "control" as const, roles: ["platform_admin"] },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    };
    expect(__operationMayInvokeForTests(controlTool, tenant)).toBe(false);
    expect(__operationMayInvokeForTests(controlTool, admin)).toBe(false);
    const sessionTool = { ...controlTool, auth: { mode: "session" as const, roles: ["platform_admin"] } };
    expect(__operationMayInvokeForTests(sessionTool, tenant)).toBe(true);
    expect(__operationMayInvokeForTests(sessionTool, admin)).toBe(false);
  });
});
