// SPDX-License-Identifier: BUSL-1.1
/**
 * The canonical delegation Operation as a contract: that it binds to the core
 * runtime in every process, that nothing else can be bound in its place, and
 * that every refusal a caller can provoke without a record is answered before
 * any database work. What a real grant does to a real record is in
 * record-action-delegation-db.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { operationErrorOf } from "@openshapeforge/operations";
import { API_KEY_MANAGE_ROLE } from "../auth/api-key/ceiling.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { ModuleOperationContext } from "../modules/contract.js";
import {
  RECORD_ACTIONS_PLUGIN,
  recordActionOperationHandler,
  recordActionOperationHandlerNames,
} from "./record-action-operations.js";
import { RECORD_ACTION_DELEGATION_OPERATION } from "./entity/index.js";
import { bindOperationHandlers, invokeOperation } from "./runtime.js";

const recordId = "11111111-1111-4111-8111-111111111111";
const integrationId = "22222222-2222-4222-8222-222222222222";

const session = (overrides: Partial<Record<string, unknown>> = {}): TrustedSessionContext =>
  ({
    tenantId: "33333333-3333-4333-8333-333333333333",
    userId: "44444444-4444-4444-8444-444444444444",
    roles: [API_KEY_MANAGE_ROLE],
    groups: [],
    scope: "tenant",
    credential: "bearer",
    principalKind: "person",
    ...overrides,
  }) as unknown as TrustedSessionContext;

/** Any database access in these cases is itself the failure. */
const unusableDb = {} as OpenShapeForgeDatabase;

const run = (input: Record<string, unknown>, carrier = session()) =>
  Promise.resolve(
    recordActionOperationHandler({ key: "delegate", handler: "delegateRecordAction" })(
      input,
      { db: unusableDb, session: carrier, transport: "operation" } as unknown as ModuleOperationContext,
    ),
  );

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

describe("the canonical record-action delegation Operation", () => {
  test("binds to the core runtime, and no plugin may stand in for it", () => {
    const bound = bindOperationHandlers([]);
    const entry = bound.get(RECORD_ACTION_DELEGATION_OPERATION);
    expect(entry).toBeDefined();
    expect(entry!.operation.plugin).toBe(RECORD_ACTIONS_PLUGIN);
    expect([entry!.operation.handler]).toEqual([...recordActionOperationHandlerNames()]);
    expect(entry!.operation.auth.mode).toBe("session");
    expect(entry!.operation.tenancy.mode).toBe("required");
    expect(entry!.operation.effects.data).toBe("write");
  });

  test("the only handler name is the one the catalog names", () => {
    expect(() => recordActionOperationHandler({ key: "x", handler: "somethingElse" }))
      .toThrow(/Unknown core record-action handler/);
  });

  test("canonical dispatch validates the request before the handler runs", async () => {
    const operation = bindOperationHandlers([]).get(RECORD_ACTION_DELEGATION_OPERATION)!;
    const context = { transport: "operation" as const, session: session() };
    for (const input of [
      {},
      // Lower-case entity, upper-case action, and an action restating a
      // permission: all refused by the declared input schema.
      { entity: "run", recordId, action: "start", grant: { users: [recordId] } },
      { entity: "Run", recordId, action: "Start", grant: { users: [recordId] } },
      { entity: "Run", recordId: "not-a-uuid", action: "start", grant: { users: [recordId] } },
      { entity: "Run", recordId, action: "start", grant: {} },
      { entity: "Run", recordId, action: "start", grant: { unknown: [recordId] } },
      { entity: "Run", recordId, action: "start", grant: { integrations: ["osf_live_abc"] } },
    ]) {
      await expect(invokeOperation(operation, input, context)).rejects.toMatchObject({ status: 400 });
    }
  });

  test("every carrier but a verified person is refused before any record is read", async () => {
    // The unknown entity is the NEXT refusal after the carrier gate, and it
    // is answered from the in-memory catalog — so one input tells the two
    // answers apart without a database: FORBIDDEN means the carrier was
    // refused, GENERATED_CRUD_NOT_ENABLED means it got past the gate.
    const input = {
      entity: "NoSuchEntityHere", recordId, action: "start", grant: { users: [recordId] },
    };
    const refused: [string, TrustedSessionContext][] = [
      ["an api-key session, holding every role there is",
        session({ credential: "api-key", roles: [API_KEY_MANAGE_ROLE, "Runs.All.ReadWrite"] })],
      ["the resolved application behind that key",
        session({ credential: "api-key", principalKind: "service", appPrincipal: { integrationId } })],
      ["a bearer service account of that same integration",
        session({ principalKind: "service" })],
      // The one this used to admit: a bearer the verifier recognised as
      // neither a person nor a service account is not evidence of a person.
      ["a bearer the verifier could classify as neither",
        session({ principalKind: undefined })],
      // An identity link is not a classification. A link row is recorded for
      // every service account on its first session, and an administrator may
      // point any identity at any Relation the tenant holds, so the party's
      // own type is a fact about a row somebody chose — never about how this
      // session authenticated. Neither a link naming this very user nor one
      // naming another is evidence of a person.
      ["a bearer whose only person-ish fact is a link naming this user",
        session({
          principalKind: undefined,
          relation: {
            identityId: integrationId, issuer: "https://identity.example/realms/test",
            subject: "44444444-4444-4444-8444-444444444444", status: "linked",
            relationId: recordId, relationType: "person",
          },
        })],
      ["a bearer whose only person-ish fact is a link that is not its own",
        session({
          principalKind: undefined,
          relation: {
            identityId: integrationId, issuer: "https://identity.example/realms/test",
            subject: recordId, status: "linked",
          },
        })],
      // The payload-v2 in-mesh bundle: accepted for ordinary work, and it
      // carries no class, so it is refused here. Redeploying its producer to
      // sign v3 is the fix, not widening this gate.
      ["a signed bundle from a producer that predates the signed class",
        session({ credential: "trusted-context", principalKind: undefined })],
      ["a capability grant", session({ credential: "grant", principalKind: undefined })],
      ["a control-realm operator, who is no member of this tenant",
        session({ credential: "control-bearer" })],
      ["a signed bundle that somehow names an application",
        session({
          credential: "trusted-context", principalKind: undefined,
          appPrincipal: { integrationId },
        })],
      // The other half of the same rule. `readTrustedSessionContext` sets
      // neither of these on this carrier, so both are belt and braces — and
      // both are asserted, so a later change that lets signed content reach
      // either field cannot quietly widen the gate.
      ["a signed bundle that somehow claims a service principal",
        session({ credential: "trusted-context", principalKind: "service" })],
    ];
    for (const [carrier, carrierSession] of refused) {
      expect([carrier, await refusalOf(run(input, carrierSession))])
        .toEqual([carrier, "FORBIDDEN"]);
    }

    // Two carriers, one condition: the deployment itself classified the
    // principal as a person. Nothing else is admitted, and absence is not.
    const admitted: [string, TrustedSessionContext][] = [
      ["a person the bearer verifier classified", session()],
      // The in-mesh hop signs the class INSIDE its HMAC (packages/auth,
      // payload v3), and apps/web signs "person" only for a session it
      // established through an interactive login.
      ["a signed bundle whose producer signed the person class",
        session({ credential: "trusted-context" })],
    ];
    for (const [carrier, carrierSession] of admitted) {
      expect([carrier, await refusalOf(run(input, carrierSession))])
        .toEqual([carrier, "GENERATED_CRUD_NOT_ENABLED"]);
    }
  });

  test("a call that changes nothing, and an unknown entity, are refused", async () => {
    expect(await refusalOf(run({ entity: "Relation", recordId, action: "start" })))
      .toBe("BAD_USER_INPUT");
    expect(await refusalOf(run({
      entity: "NoSuchEntityHere", recordId, action: "start", grant: { users: [recordId] },
    }))).toBe("GENERATED_CRUD_NOT_ENABLED");
  });

  test("an authenticated session is required", async () => {
    expect(await refusalOf(run(
      { entity: "Relation", recordId, action: "start", grant: { users: [recordId] } },
      session({ userId: null }),
    ))).toBe("UNAUTHENTICATED");
  });
});
