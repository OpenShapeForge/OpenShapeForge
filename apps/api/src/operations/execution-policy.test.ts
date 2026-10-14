// SPDX-License-Identifier: BUSL-1.1
/**
 * The host execution admission guard, offline.
 *
 * Kysely's DummyDriver gives a real transaction boundary without a server, so
 * the whole guard — classification, session capability, decision validation,
 * composition and fail-closed behaviour — is provable without a database. The
 * tenant-scoping half (which GUCs the policy transaction carries, and that a
 * policy read is restricted to its own tenant by row-level security) needs
 * PostgreSQL and lives in execution-policy-db.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type Transaction,
} from "kysely";
import { operationErrorOf } from "@openshapeforge/operations";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DB } from "../generated/db/types.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { ModuleExecutionPolicy, RuntimeModule } from "../modules/contract.js";
import type { ModuleLoadFailure } from "../modules/registry.js";
import { toHttpError } from "../rest/http-error.js";
import {
  assertOperationAdmitted,
  EXECUTION_NOT_PERMITTED,
  isGovernedOperation,
  operationAdmissionRefusal,
  operationExecutionPoliciesConfigured,
  registerOperationExecutionPolicies,
  type GovernedOperation,
} from "./execution-policy.js";

function offlineDatabase(): OpenShapeForgeDatabase {
  return new Kysely<DB>({
    dialect: {
      createDriver: () => new DummyDriver(),
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

function tenantSession(
  overrides: Partial<TrustedSessionContext> = {},
): TrustedSessionContext {
  return {
    tenantId: randomUUID(),
    userId: randomUUID(),
    roles: ["CaseFile.All.ReadWrite"],
    groups: [],
    relationGroupIds: [],
    scope: "self",
    credential: "bearer",
    ...overrides,
  };
}

const WRITE: GovernedOperation = {
  id: "Relation.update",
  intent: "update",
  effects: { data: "write", external: "none" },
};
const READ: GovernedOperation = {
  id: "Relation.get",
  intent: "get",
  effects: { data: "read", external: "none" },
};

function module(
  name: string,
  ...policies: ModuleExecutionPolicy[]
): RuntimeModule {
  return { name, executionPolicies: policies } as RuntimeModule;
}

function failure(name: string, reason: ModuleLoadFailure["reason"]): ModuleLoadFailure {
  return { name, specifier: "(loaded)", reason, message: "its catalog could not be hydrated" };
}

/** A policy that answers the same way for every governed Operation. */
function fixedPolicy(
  name: string,
  decision: unknown,
  calls?: string[],
): ModuleExecutionPolicy {
  return {
    name,
    evaluate: () => {
      calls?.push(name);
      return decision as never;
    },
  };
}

async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("The guard admitted an Operation it should have refused.");
}

const refusalOf = async (promise: Promise<unknown>) => {
  const thrown = await thrownBy(promise);
  const operationError = operationErrorOf(thrown);
  if (!operationError) throw thrown;
  return operationError;
};

describe("which Operations the guard governs", () => {
  test("data writes, deletes and external writes are governed; plain reads are not", () => {
    expect(isGovernedOperation({ data: "write", external: "none" })).toBe(true);
    expect(isGovernedOperation({ data: "delete", external: "none" })).toBe(true);
    expect(isGovernedOperation({ data: "read", external: "write" })).toBe(true);
    expect(isGovernedOperation({ data: "read", external: "none" })).toBe(false);
    expect(isGovernedOperation({ data: "read", external: "read" })).toBe(false);
  });

  test("a declaration outside the compiler's vocabulary counts as a change", () => {
    // Only a runtime Operation provider can report this, and it is plugin
    // code: core reads what it cannot classify as the governed case.
    expect(isGovernedOperation({ data: "maybe", external: "none" } as never)).toBe(true);
    expect(isGovernedOperation({ data: "read", external: "sometimes" } as never)).toBe(true);
    expect(isGovernedOperation(undefined as never)).toBe(true);
  });
});

describe("registering contributed policies", () => {
  test("a host with no contribution registers nothing", () => {
    const db = offlineDatabase();
    registerOperationExecutionPolicies(db, [{ name: "quiet" } as RuntimeModule]);
    expect(operationExecutionPoliciesConfigured(db)).toBe(false);
  });

  test("the same policy name from two modules is refused at boot", () => {
    const db = offlineDatabase();
    expect(() =>
      registerOperationExecutionPolicies(db, [
        module("first", fixedPolicy("freeze", { admitted: true })),
        module("second", fixedPolicy("freeze", { admitted: true })),
      ])
    ).toThrow(/contributed more than once/);
  });

  test("a policy without a usable name or evaluate function is refused at boot", () => {
    const db = offlineDatabase();
    expect(() =>
      registerOperationExecutionPolicies(db, [
        module("broken", { name: " ", evaluate: () => ({ admitted: true }) }),
      ])
    ).toThrow(/invalid execution policy/);
    expect(() =>
      registerOperationExecutionPolicies(db, [
        module("broken", { name: "nameless" } as ModuleExecutionPolicy),
      ])
    ).toThrow(/invalid execution policy/);
  });

  test("a configured contributor that failed to initialise refuses boot", () => {
    // The module object exists from the moment it loads, so core can tell a
    // MISSING enforcement owner from a host that deliberately has none.
    const db = offlineDatabase();
    const contributor = module("tenant-policy", fixedPolicy("freeze", { admitted: true }));
    expect(() =>
      registerOperationExecutionPolicies(db, {
        loaded: [{ name: "surviving-crud" } as RuntimeModule],
        failures: [failure("tenant-policy", "init_failed")],
        candidates: [contributor, { name: "surviving-crud" } as RuntimeModule],
      })
    ).toThrow(/"tenant-policy" \(init_failed[\s\S]*did not initialise/);
    expect(operationExecutionPoliciesConfigured(db)).toBe(false);
  });

  test("a failed module that contributes no policy leaves registration unchanged", () => {
    const db = offlineDatabase();
    const contributor = module("tenant-policy", fixedPolicy("freeze", { admitted: true }));
    registerOperationExecutionPolicies(db, {
      loaded: [contributor],
      failures: [failure("unrelated", "init_failed")],
      candidates: [contributor, { name: "unrelated" } as RuntimeModule],
    });
    expect(operationExecutionPoliciesConfigured(db)).toBe(true);
  });

  test("a module that never loaded is registered as the unknown it is", () => {
    // Nothing of a module that failed to import exists for core to read, so
    // its contract cannot be judged here; docs/execution-policies.md names
    // this limit and what a host does about it.
    const db = offlineDatabase();
    const contributor = module("tenant-policy", fixedPolicy("freeze", { admitted: true }));
    registerOperationExecutionPolicies(db, {
      loaded: [contributor],
      failures: [failure("never-imported", "module_missing")],
      candidates: [contributor],
    });
    expect(operationExecutionPoliciesConfigured(db)).toBe(true);
  });
});

describe("admission", () => {
  test("without a registered policy every governed Operation is admitted", async () => {
    const db = offlineDatabase();
    await assertOperationAdmitted(db, tenantSession(), WRITE);
  });

  test("the refusal is also available as a value, for a caller that settles it", async () => {
    // The job worker records the refusal on the queue row rather than
    // throwing it at a caller, so it needs the decision, not an exception.
    const db = offlineDatabase();
    expect(await operationAdmissionRefusal(db, tenantSession(), WRITE)).toBeUndefined();
    registerOperationExecutionPolicies(db, [
      module("host", fixedPolicy("deadline", {
        admitted: false,
        refusal: { message: "This workspace is read-only.", retryAt: "2026-10-20T00:00:00Z" },
      })),
    ]);
    expect(await operationAdmissionRefusal(db, tenantSession(), WRITE)).toEqual({
      code: EXECUTION_NOT_PERMITTED,
      message: "This workspace is read-only.",
      retryable: true,
      retryAt: "2026-10-20T00:00:00Z",
    });
  });

  test("an admitting policy admits the write", async () => {
    const db = offlineDatabase();
    registerOperationExecutionPolicies(db, [
      module("host", fixedPolicy("open", { admitted: true })),
    ]);
    await assertOperationAdmitted(db, tenantSession(), WRITE);
  });

  test("a refusing policy denies the write with core's code and the policy's wording", async () => {
    const db = offlineDatabase();
    registerOperationExecutionPolicies(db, [
      module("host", fixedPolicy("deadline", {
        admitted: false,
        refusal: {
          message: "This workspace is read-only.",
          detail: "Ask an administrator to extend it.",
        },
      })),
    ]);
    const thrown = await thrownBy(assertOperationAdmitted(db, tenantSession(), WRITE));
    expect(operationErrorOf(thrown)).toEqual({
      code: EXECUTION_NOT_PERMITTED,
      message: "This workspace is read-only.",
      detail: "Ask an administrator to extend it.",
      retryable: false,
    });
    // The refusal is a canonical Operation failure, so every transport
    // projects it the same way; REST answers 403 rather than a redacted 500.
    expect(toHttpError(thrown)).toEqual({
      status: 403,
      body: {
        error: {
          code: EXECUTION_NOT_PERMITTED,
          message: "This workspace is read-only.",
          detail: "Ask an administrator to extend it.",
          retryable: false,
        },
      },
    });
  });

  test("a refusal that names when it ends is retryable from then", async () => {
    const db = offlineDatabase();
    const retryAt = "2026-10-14T12:00:00.000Z";
    registerOperationExecutionPolicies(db, [
      module("host", fixedPolicy("maintenance", {
        admitted: false,
        refusal: { message: "Maintenance is in progress.", retryAt },
      })),
    ]);
    expect(await refusalOf(assertOperationAdmitted(db, tenantSession(), WRITE)))
      .toEqual({
        code: EXECUTION_NOT_PERMITTED,
        message: "Maintenance is in progress.",
        retryable: true,
        retryAt,
      });
  });

  test("a declared read is admitted without consulting any policy", async () => {
    const db = offlineDatabase();
    const calls: string[] = [];
    registerOperationExecutionPolicies(db, [
      module("host", fixedPolicy("deny-all", { admitted: false, refusal: { message: "No." } }, calls)),
    ]);
    await assertOperationAdmitted(db, tenantSession(), READ);
    await assertOperationAdmitted(db, tenantSession(), {
      id: "Relation.list",
      intent: "list",
      effects: { data: "read", external: "read" },
    });
    expect(calls).toEqual([]);
  });

  test("an external write under a declared data read is still governed", async () => {
    const db = offlineDatabase();
    registerOperationExecutionPolicies(db, [
      module("host", fixedPolicy("deny-all", { admitted: false, refusal: { message: "No." } })),
    ]);
    expect(
      (await refusalOf(assertOperationAdmitted(db, tenantSession(), {
        id: "Invoice.send",
        intent: "invoke",
        effects: { data: "read", external: "write" },
      }))).code,
    ).toBe(EXECUTION_NOT_PERMITTED);
  });

  test("a session without a tenant is outside the tenant guard", async () => {
    const db = offlineDatabase();
    const calls: string[] = [];
    registerOperationExecutionPolicies(db, [
      module("host", fixedPolicy("deny-all", { admitted: false, refusal: { message: "No." } }, calls)),
    ]);
    await assertOperationAdmitted(
      db,
      tenantSession({ tenantId: null, credential: "control-bearer" }),
      WRITE,
    );
    await assertOperationAdmitted(db, undefined, WRITE);
    expect(calls).toEqual([]);
  });

  test("an unclassifiable declaration is refused like a governed write", async () => {
    const db = offlineDatabase();
    registerOperationExecutionPolicies(db, [
      module("host", fixedPolicy("deny-all", { admitted: false, refusal: { message: "No." } })),
    ]);
    expect(
      (await refusalOf(assertOperationAdmitted(db, tenantSession(), {
        id: "provider.unknown",
        intent: "invoke",
        effects: { data: "whatever", external: "whatever" } as never,
      }))).code,
    ).toBe(EXECUTION_NOT_PERMITTED);
  });

  test("a session whose roles are absent still reaches the policy as an empty set", async () => {
    const db = offlineDatabase();
    let roles: readonly string[] | undefined;
    registerOperationExecutionPolicies(db, [
      module("host", {
        name: "inspect",
        evaluate: (_request, context) => {
          roles = context.session.roles;
          return { admitted: true };
        },
      }),
    ]);
    await assertOperationAdmitted(
      db,
      { tenantId: randomUUID(), userId: randomUUID(), roles: null, groups: null },
      WRITE,
    );
    expect(roles).toEqual([]);
  });
});

describe("a policy that cannot answer fails closed", () => {
  const malformed: readonly [string, unknown][] = [
    ["nothing at all", undefined],
    ["a bare boolean", true],
    ["a missing discriminant", {}],
    ["an array", [{ admitted: true }]],
    ["an admission with extra keys", { admitted: true, refusal: { message: "x" } }],
    ["a refusal with no reason", { admitted: false }],
    ["a refusal with an empty message", { admitted: false, refusal: { message: "  " } }],
    ["a refusal with a non-string message", { admitted: false, refusal: { message: 7 } }],
    ["a refusal with its own error code", {
      admitted: false,
      refusal: { message: "Nope.", code: "FORBIDDEN" },
    }],
    ["a refusal with structured payload", {
      admitted: false,
      refusal: { message: "Nope.", data: { sql: "select 1" } },
    }],
    ["a refusal with an unparseable retryAt", {
      admitted: false,
      refusal: { message: "Nope.", retryAt: "tomorrow" },
    }],
    ["a refusal whose message is unbounded", {
      admitted: false,
      refusal: { message: "x".repeat(501) },
    }],
  ];

  for (const [label, decision] of malformed) {
    test(`${label} denies the write with core's own wording`, async () => {
      const db = offlineDatabase();
      registerOperationExecutionPolicies(db, [
        module("host", fixedPolicy("sloppy", decision)),
      ]);
      const error = await refusalOf(assertOperationAdmitted(db, tenantSession(), WRITE));
      expect(error.code).toBe(EXECUTION_NOT_PERMITTED);
      expect(error.message).toBe("This change is not permitted right now.");
      expect(error.detail).toBe('The server could not evaluate the "sloppy" execution policy.');
      expect(error.retryable).toBe(false);
    });
  }

  test("a throwing policy denies the write and does not leak its cause", async () => {
    const db = offlineDatabase();
    registerOperationExecutionPolicies(db, [
      module("host", {
        name: "throws",
        evaluate: () => {
          throw new Error("connect ECONNREFUSED 10.0.0.9:5432");
        },
      }),
    ]);
    const error = await refusalOf(assertOperationAdmitted(db, tenantSession(), WRITE));
    expect(error.code).toBe(EXECUTION_NOT_PERMITTED);
    expect(JSON.stringify(error)).not.toContain("ECONNREFUSED");
  });

  test("a rejecting policy denies the write", async () => {
    const db = offlineDatabase();
    registerOperationExecutionPolicies(db, [
      module("host", { name: "rejects", evaluate: () => Promise.reject(new Error("nope")) }),
    ]);
    expect((await refusalOf(assertOperationAdmitted(db, tenantSession(), WRITE))).code)
      .toBe(EXECUTION_NOT_PERMITTED);
  });
});

describe("composition of several policies", () => {
  test("every policy must admit, and the first refusal short-circuits the rest", async () => {
    const db = offlineDatabase();
    const calls: string[] = [];
    registerOperationExecutionPolicies(db, [
      module("host", fixedPolicy("a-open", { admitted: true }, calls)),
      module("operator", fixedPolicy("b-closed", {
        admitted: false,
        refusal: { message: "Frozen for maintenance." },
      }, calls)),
      module("third", fixedPolicy("c-open", { admitted: true }, calls)),
    ]);
    expect((await refusalOf(assertOperationAdmitted(db, tenantSession(), WRITE))).message)
      .toBe("Frozen for maintenance.");
    expect(calls).toEqual(["a-open", "b-closed"]);
  });

  test("policies of one module run in a stable order, whatever the array order", async () => {
    const seen: string[] = [];
    for (const order of [["z", "a"], ["a", "z"]]) {
      const db = offlineDatabase();
      const calls: string[] = [];
      registerOperationExecutionPolicies(db, [
        module(
          "host",
          fixedPolicy(order[0]!, { admitted: true }, calls),
          fixedPolicy(order[1]!, { admitted: true }, calls),
        ),
      ]);
      await assertOperationAdmitted(db, tenantSession(), WRITE);
      seen.push(calls.join(","));
    }
    expect(seen).toEqual(["a,z", "a,z"]);
  });
});

describe("what a policy may see and may not change", () => {
  test("it receives the compiler-owned Operation identity, frozen", async () => {
    const db = offlineDatabase();
    let request: { operation: GovernedOperation } | undefined;
    registerOperationExecutionPolicies(db, [
      module("host", {
        name: "inspect",
        evaluate: (incoming) => {
          request = incoming as never;
          return { admitted: true };
        },
      }),
    ]);
    await assertOperationAdmitted(db, tenantSession(), {
      id: "Invoice.issue",
      intent: "invoke",
      effects: { data: "write", external: "write" },
    });
    expect(request!.operation).toEqual({
      id: "Invoice.issue",
      intent: "invoke",
      effects: { data: "write", external: "write" },
    });
    expect(Object.isFrozen(request!)).toBe(true);
    expect(Object.isFrozen(request!.operation)).toBe(true);
    expect(Object.isFrozen(request!.operation.effects)).toBe(true);
  });

  test("a policy that rewrites its request or session cannot widen the next decision", async () => {
    const db = offlineDatabase();
    const session = tenantSession();
    const observed: string[][] = [];
    registerOperationExecutionPolicies(db, [
      module("host", {
        name: "a-tamper",
        evaluate: (request, context) => {
          const mutable = context.session as { roles: string[] };
          try {
            mutable.roles.push("Platform.SystemBypass");
          } catch {
            // Frozen, which is the point.
          }
          try {
            (request.operation as { effects: { data: string } }).effects.data = "read";
          } catch {
            // Frozen, which is the point.
          }
          return { admitted: true };
        },
      }),
      module("operator", {
        name: "b-observe",
        evaluate: (request, context) => {
          observed.push([...context.session.roles]);
          observed.push([request.operation.effects.data]);
          return { admitted: true };
        },
      }),
    ]);
    await assertOperationAdmitted(db, session, WRITE);
    expect(observed).toEqual([["CaseFile.All.ReadWrite"], ["write"]]);
    expect(session.roles).toEqual(["CaseFile.All.ReadWrite"]);
  });

  test("it receives a transaction and the verified session, not a connection or a URL", async () => {
    const db = offlineDatabase();
    let context: { db: Transaction<DB>; session: TrustedSessionContext } | undefined;
    const session = tenantSession({ roles: ["Relation.All.ReadWrite"] });
    registerOperationExecutionPolicies(db, [
      module("host", {
        name: "inspect",
        evaluate: (_request, incoming) => {
          context = incoming;
          return { admitted: true };
        },
      }),
    ]);
    await assertOperationAdmitted(db, session, WRITE);
    expect(typeof context!.db.selectFrom).toBe("function");
    expect(context!.session.tenantId).toBe(session.tenantId);
    expect(context!.session.userId).toBe(session.userId);
    expect(context!.session.roles).toEqual(["Relation.All.ReadWrite"]);
    expect(Object.isFrozen(context!.session)).toBe(true);
    expect(JSON.stringify(context!.session)).not.toContain("postgres://");
  });
});

describe("a second, unrelated policy proves the seam is generic", () => {
  /**
   * An operator maintenance freeze: no tenant deadline, no product state, no
   * stored rows — only the operator-configured window the host passed in. The
   * guard needs nothing from the policy beyond a decision, which is what makes
   * it usable for a second purpose without touching core.
   */
  function maintenanceFreeze(window: { from: Date; until: Date }, now: () => Date): ModuleExecutionPolicy {
    return {
      name: "operator-maintenance-freeze",
      evaluate: () => {
        const at = now();
        if (at < window.from || at >= window.until) return { admitted: true };
        return {
          admitted: false,
          refusal: {
            message: "The platform is being maintained; changes are paused.",
            retryAt: window.until.toISOString(),
          },
        };
      },
    };
  }

  const window = {
    from: new Date("2026-10-14T22:00:00.000Z"),
    until: new Date("2026-10-14T23:00:00.000Z"),
  };

  test("admits writes outside the window", async () => {
    const db = offlineDatabase();
    registerOperationExecutionPolicies(db, [
      module("operator", maintenanceFreeze(window, () => new Date("2026-10-14T21:59:59.000Z"))),
    ]);
    await assertOperationAdmitted(db, tenantSession(), WRITE);
  });

  test("refuses writes inside the window and says when they resume", async () => {
    const db = offlineDatabase();
    registerOperationExecutionPolicies(db, [
      module("operator", maintenanceFreeze(window, () => new Date("2026-10-14T22:30:00.000Z"))),
    ]);
    expect(await refusalOf(assertOperationAdmitted(db, tenantSession(), WRITE))).toEqual({
      code: EXECUTION_NOT_PERMITTED,
      message: "The platform is being maintained; changes are paused.",
      retryable: true,
      retryAt: "2026-10-14T23:00:00.000Z",
    });
  });

  test("leaves reads alone inside the window", async () => {
    const db = offlineDatabase();
    registerOperationExecutionPolicies(db, [
      module("operator", maintenanceFreeze(window, () => new Date("2026-10-14T22:30:00.000Z"))),
    ]);
    await assertOperationAdmitted(db, tenantSession(), READ);
  });
});
