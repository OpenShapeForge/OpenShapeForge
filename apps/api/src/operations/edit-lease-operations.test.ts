// SPDX-License-Identifier: BUSL-1.1
/**
 * The canonical edit-lease Operations: that they dispatch to the core runtime
 * at all, and that every refusal the caller can provoke without a record is
 * answered before any lease work. The database-backed behaviour — taking,
 * renewing and giving back a real lease, and what another tenant or subject
 * may do with its token — is in edit-lease-operations-db.test.ts.
 */
import { describe, expect, test } from "bun:test";
import {
  EDIT_LEASE_TOOL_NAMES,
  editLeaseToolDefinitions,
  operationErrorOf,
} from "@openshapeforge/operations";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { httpStatusForCode } from "../connectors/provider-outcome.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { emptyCatalogDatabase } from "../db/__tests__/empty-catalog-db.js";
import { editLeaseOperationIdsForSession } from "../mcp/edit-lease-tools.js";
import type { ModuleOperationContext } from "../modules/contract.js";
import {
  EDIT_LEASES_PLUGIN,
  editLeaseOperationHandler,
  editLeaseOperationHandlerNames,
} from "./edit-lease-operations.js";
import {
  canonicalEditLeaseOperationIdsForSession,
  getEntityOperationContracts,
} from "./entity/index.js";
import { bindOperationHandlers, invokeOperation } from "./runtime.js";

const update = getEntityOperationContracts().find(({ id }) => id === "Relation.update")!;
const editor = update.authorization.roles[0]!;

const sessionWith = (roles: readonly string[]): TrustedSessionContext =>
  ({
    tenantId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    roles,
    groups: [],
    scope: "tenant",
    credential: "bearer",
  }) as unknown as TrustedSessionContext;

/** Authorization may read the empty policy catalogue before refusing a lease. */
const unusableDb = emptyCatalogDatabase();

function contextFor(
  session: TrustedSessionContext | undefined,
  db: OpenShapeForgeDatabase | undefined = unusableDb,
): ModuleOperationContext {
  return { db, session, transport: "operation" } as unknown as ModuleOperationContext;
}

async function refusalOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    const failure = operationErrorOf(error);
    if (failure) return failure.code;
    throw error;
  }
  throw new Error("Expected the Operation to refuse.");
}

const run = (handler: string, input: Record<string, unknown>, context: ModuleOperationContext) =>
  Promise.resolve(editLeaseOperationHandler({ key: handler, handler })(input, context));

describe("canonical edit-lease Operations", () => {
  test("bind to the core runtime in every process", () => {
    const bound = bindOperationHandlers([]);
    const ids = ["entity.edit-lease.acquire", "entity.edit-lease.renew", "entity.edit-lease.release"];
    expect(ids.filter((id) => bound.has(id))).toEqual(ids);
    expect(ids.map((id) => bound.get(id)!.operation.plugin)).toEqual(ids.map(() => EDIT_LEASES_PLUGIN));
    expect(ids.map((id) => bound.get(id)!.operation.handler).sort())
      .toEqual([...editLeaseOperationHandlerNames()]);
    // Every one of them needs a tenant session; none may be reached anonymously.
    for (const id of ids) {
      expect(bound.get(id)!.operation.auth.mode).toBe("session");
      expect(bound.get(id)!.operation.tenancy.mode).toBe("required");
    }
  });

  test("canonical dispatch validates the request before the handler runs", async () => {
    const release = bindOperationHandlers([]).get("entity.edit-lease.release")!;
    const context = { transport: "operation" as const, session: sessionWith([editor]) };
    await expect(invokeOperation(release, { leaseToken: "too-short" }, context))
      .rejects.toMatchObject({ status: 400 });
    await expect(invokeOperation(release, {}, context)).rejects.toMatchObject({ status: 400 });
    // A well-formed request does reach the handler, which needs a database.
    expect(await refusalOf(invokeOperation(
      release,
      { leaseToken: "l".repeat(43) },
      context,
    ))).toBe("DATABASE_NOT_CONFIGURED");
    // A token long enough for the schema but carrying nothing is the handler's
    // own refusal, so the lease-holder contracts declare it as well.
    expect(await refusalOf(run(
      "releaseEditLease",
      { leaseToken: " ".repeat(21) },
      contextFor(sessionWith([editor])),
    ))).toBe("BAD_USER_INPUT");
    expect(new Map(release.operation.errors.map(({ code, status }) => [code, status] as const))
      .get("BAD_USER_INPUT")).toBe(httpStatusForCode("BAD_USER_INPUT"));
  });

  test("refuse without a verified tenant subject", async () => {
    const anonymous = contextFor(undefined);
    expect(await refusalOf(run("acquireEditLease", { operationId: update.id, targetId: "t" }, anonymous)))
      .toBe("UNAUTHENTICATED");
    expect(await refusalOf(run("renewEditLease", { leaseToken: "l".repeat(43) }, anonymous)))
      .toBe("UNAUTHENTICATED");
    expect(await refusalOf(run("releaseEditLease", { leaseToken: "l".repeat(43) }, anonymous)))
      .toBe("UNAUTHENTICATED");
    // A tenant without a subject is no lease holder either.
    const subjectless = contextFor(
      { ...sessionWith([editor]), userId: null } as unknown as TrustedSessionContext,
    );
    expect(await refusalOf(run("releaseEditLease", { leaseToken: "l".repeat(43) }, subjectless)))
      .toBe("UNAUTHENTICATED");
  });

  test("acquiring is authorized by the Operation it names, before any lease work", async () => {
    expect(await refusalOf(run(
      "acquireEditLease",
      { operationId: update.id, targetId: "33333333-3333-4333-8333-333333333333" },
      contextFor(sessionWith([])),
    ))).toBe("FORBIDDEN");
    // Naming an Operation is never a route to one the caller cannot invoke.
    expect(await refusalOf(run(
      "acquireEditLease",
      { operationId: "Relation.get", targetId: "33333333-3333-4333-8333-333333333333" },
      contextFor(sessionWith([editor])),
    ))).toBe("LEASE_NOT_SUPPORTED");
    // An Operation this deployment did not compile is not a lease refusal and
    // not a missing record: it is the catalog answer the entity runtime gives.
    expect(await refusalOf(run(
      "acquireEditLease",
      { operationId: "Relation.invented", targetId: "33333333-3333-4333-8333-333333333333" },
      contextFor(sessionWith([editor])),
    ))).toBe("GENERATED_CRUD_NOT_ENABLED");
    expect(await refusalOf(run(
      "acquireEditLease",
      { operationId: "  ", targetId: "33333333-3333-4333-8333-333333333333" },
      contextFor(sessionWith([editor])),
    ))).toBe("BAD_USER_INPUT");
  });

  test("the acquire descriptor says what acquiring actually does", () => {
    const bound = bindOperationHandlers([]);
    const acquire = bound.get("entity.edit-lease.acquire")!.operation;
    // A second acquire by the same holder mints a fresh token and replaces the
    // stored hash (entity/edit-leases.ts), so a retry is not the same call
    // twice: it retires the token the first one returned. The MCP projection of
    // the same service reports exactly that with idempotentHint false, and the
    // token-carrying halves keep their natural idempotency.
    expect(acquire.idempotency).toEqual({ mode: "none" });
    for (const id of ["entity.edit-lease.renew", "entity.edit-lease.release"]) {
      expect(bound.get(id)!.operation.idempotency).toEqual({ mode: "intrinsic" });
    }
    const hints = new Map(
      editLeaseToolDefinitions([update.id]).map((tool) =>
        [tool.name, tool.annotations.idempotentHint] as const
      ),
    );
    expect(EDIT_LEASE_TOOL_NAMES.map((name) => hints.get(name))).toEqual(
      ["entity.edit-lease.acquire", "entity.edit-lease.renew", "entity.edit-lease.release"]
        .map((id) => bound.get(id)!.operation.idempotency.mode !== "none"),
    );

    // Every refusal the cases above provoke is declared, with the status the
    // transports answer for it. DATABASE_NOT_CONFIGURED is not: a server
    // without its database is a fault, not an answer this contract offers.
    const declared = new Map(acquire.errors.map(({ code, status }) => [code, status] as const));
    for (const code of ["BAD_USER_INPUT", "FORBIDDEN", "LEASE_NOT_SUPPORTED", "GENERATED_CRUD_NOT_ENABLED"]) {
      expect(`${code} ${declared.get(code)}`).toBe(`${code} ${httpStatusForCode(code)}`);
    }
  });

  test("renewing refuses an identity that may invoke no lease-protected Operation", async () => {
    expect(await refusalOf(run(
      "renewEditLease",
      { leaseToken: "l".repeat(43) },
      contextFor(sessionWith([])),
    ))).toBe("LEASE_EXPIRED");
  });

  test("the canonical list is the authorization contract, not an interface projection", () => {
    const session = sessionWith([editor]);
    expect(canonicalEditLeaseOperationIdsForSession(session)).toContain(update.id);
    expect(canonicalEditLeaseOperationIdsForSession(sessionWith([]))).toEqual([]);
    // The MCP projection narrows what that interface offers; the Operation
    // keeps its own contract when nothing is projected there.
    expect(editLeaseOperationIdsForSession(session, [])).toEqual([]);
  });
});
