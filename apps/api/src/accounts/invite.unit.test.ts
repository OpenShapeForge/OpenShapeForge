// SPDX-License-Identifier: BUSL-1.1
/**
 * `accounts.create` answers its refusals with the statuses and codes it
 * declares, in the canonical error body, so the runtime passes them through
 * instead of replacing each with a 500 contract violation. Keycloak's own
 * error text never reaches the caller.
 */
import { expect, test } from "bun:test";
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from "kysely";
import rawCatalog from "../generated/operations/catalog.json" with { type: "json" };
import { KeycloakAdminError } from "../control/keycloak-organization-admin.js";
import { bindOperationHandlers, invokeOperation, type OperationContract } from "../operations/runtime.js";
import { inviteAccount } from "./invite.js";

const operation = rawCatalog.operations.find((row) => row.key === "accounts.create") as OperationContract;
const bound = bindOperationHandlers([{ name: "accounts", operationHandlers: { inviteAccount } }], [operation]).get("accounts.create")!;
const tenantId = "11111111-1111-4111-8111-111111111111";
const relationId = "22222222-2222-4222-8222-222222222222";
const input = { relationId, email: "new.colleague@example.test" };
const session = (roles: string[]) => ({ tenantId, userId: "33333333-3333-4333-8333-333333333333",
  credential: "bearer", roles, groups: [], scope: "tenant" });

/** Real Kysely over a connection that knows the tenant's organization and the target relation. */
function database() {
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      if (/from platform\.tenants/.test(query.sql)) return { rows: [{ keycloak_organization_id: "org-1", keycloak_realm: "tenants" }] as R[] };
      if (/for share/.test(query.sql)) return { rows: [{ id: relationId }] as R[] };
      return { rows: [] };
    },
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> { throw new Error("Unexpected stream"); },
  };
  return new Kysely({ dialect: {
    createAdapter: () => new PostgresAdapter(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
    createDriver: () => ({
      async init() {}, async acquireConnection() { return connection; },
      async beginTransaction() {}, async commitTransaction() {}, async rollbackTransaction() {},
      async releaseConnection() {}, async destroy() {},
    }),
  } });
}

const unreachable = () => new KeycloakAdminError("KEYCLOAK_ADMIN_UNAVAILABLE",
  "Could not reach the Keycloak admin API at https://keycloak.internal.test/admin/realms/tenants as openshapeforge-auth-api", 503);
const members = {
  async hasMemberByEmail() { throw unreachable(); },
  async findPendingInvitationByEmail() { throw unreachable(); },
  async inviteUser() { throw unreachable(); },
};

async function refusal(context: Record<string, unknown>) {
  const error = await invokeOperation(bound, input, { transport: "rest", ...context } as never).then(
    () => { throw new Error("expected a refusal"); },
    (failure: unknown) => failure as { status: number; code: string; body: unknown },
  );
  return { status: error.status, code: error.code, body: error.body };
}

test("an operator without the administrator role gets the declared 403", async () => {
  const answer = await refusal({ session: session(["Organization.Access.Manage"]), db: database(),
    control: { clients: { identityMembers: members } } });
  expect(answer).toEqual({ status: 403, code: "FORBIDDEN", body: { error: { code: "FORBIDDEN",
    message: "Admitting employees requires the Organization.All.ReadWrite role.", retryable: false } } });
});

test("missing invitation configuration is the declared 503", async () => {
  const answer = await refusal({ session: session(["Organization.Access.Manage", "Organization.All.ReadWrite"]) });
  expect(answer).toEqual({ status: 503, code: "OPERATION_UNAVAILABLE", body: { error: { code: "OPERATION_UNAVAILABLE",
    message: "Account invitations are not configured.", retryable: false } } });
});

test("a Keycloak failure is the declared 503 without the provider's error text", async () => {
  const answer = await refusal({ session: session(["Organization.Access.Manage", "Organization.All.ReadWrite"]),
    db: database(), control: { clients: { identityMembers: members } } });
  expect(answer).toMatchObject({ status: 503, code: "OPERATION_UNAVAILABLE", body: { error: { code: "OPERATION_UNAVAILABLE", retryable: false } } });
  expect(JSON.stringify(answer.body)).not.toContain("keycloak.internal");
  expect(JSON.stringify(answer.body)).not.toContain("openshapeforge-auth-api");
});
