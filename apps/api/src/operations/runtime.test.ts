// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { RuntimeModule } from "../modules/contract.js";
import { bindOperationHandlers, invokeOperation, operationRestInput, requireOperationAuthorization, type OperationContract } from "./runtime.js";

const session = {
  tenantId: "tenant-a",
  userId: "user-a",
  roles: ["workflow-admin"],
  groups: [],
  scope: "tenant" as const,
  credential: "trusted-context" as const,
};

describe("canonical operation runtime", () => {
  test("fails closed when the compiler contract has no runtime handler", () => {
    expect(() => bindOperationHandlers([])).toThrow(/has no loaded runtime module/);
    expect(() => bindOperationHandlers([{ name: "workflow" }])).toThrow(/has no runtime handler/);
  });

  test("validates input and handler output against the generated contract", async () => {
    const module: RuntimeModule = {
      name: "workflow",
      operationHandlers: {
        startWebhook: async (input) => ({
          value: { status: "accepted", instanceId: "11111111-1111-4111-8111-111111111111", definitionId: input.definitionId },
        }),
      },
    };
    const bound = bindOperationHandlers([module]).get("workflow.instance.webhook-start")!;
    await expect(invokeOperation(bound, {}, { transport: "graphql", session })).rejects.toMatchObject({ status: 400 });
    const result = await invokeOperation(bound, {
      definitionId: "22222222-2222-4222-8222-222222222222",
      idempotencyKey: "webhook-1",
    }, { transport: "graphql", session });
    expect(result.value).toMatchObject({ status: "accepted" });
  });

  test("enforces declared OAuth scopes on every projected transport", async () => {
    const operation = {
      ...bindOperationHandlers([{
        name: "workflow",
        operationHandlers: { startWebhook: async () => ({ value: {} }) },
      }]).get("workflow.instance.webhook-start")!.operation,
      auth: { mode: "session" as const, roles: ["workflow-admin"], scopes: ["workflow:write"] },
    };
    expect(() => requireOperationAuthorization(operation, session)).toThrow(/OAuth scope/);
    expect(() => requireOperationAuthorization(operation, {
      ...session,
      oauthScopes: ["workflow:write"],
    })).not.toThrow();
  });

  test("rejects a success status that differs from the canonical contract", async () => {
    const bound = bindOperationHandlers([{
      name: "workflow",
      operationHandlers: {
        startWebhook: async (input) => ({
          status: 201,
          value: { status: "accepted", instanceId: "11111111-1111-4111-8111-111111111111", definitionId: input.definitionId },
        }),
      },
    }]).get("workflow.instance.webhook-start")!;
    await expect(invokeOperation(bound, {
      definitionId: "22222222-2222-4222-8222-222222222222",
      idempotencyKey: "webhook-2",
    }, { transport: "rest", session })).rejects.toMatchObject({ status: 500 });
  });

  test("does not advertise an uncontracted runtime handler", () => {
    expect(() => bindOperationHandlers([{
      name: "workflow",
      operationHandlers: { startWebhook: () => ({ value: {} }), hidden: () => ({ value: {} }) },
    }])).toThrow(/absent from its compiler contract: hidden/);
  });
});

test("REST maps a required idempotency header into canonical input only", () => {
  const operation = {
    inputSchema: {
      type: "object",
      required: ["quoteId", "idempotencyKey"],
      properties: { quoteId: { type: "string" }, idempotencyKey: { type: "string" } },
      additionalProperties: false,
    },
    idempotency: {
      mode: "idempotency-key",
      header: "Idempotency-Key",
      inputField: "idempotencyKey",
    },
    transports: { rest: { method: "POST", path: "/api/demo/quotes/:quoteId" } },
  } as unknown as OperationContract;
  const request = {
    body: {},
    query: {},
    params: { quoteId: "quote-1" },
    headers: { "idempotency-key": "replay-1" },
  } as never;
  expect(operationRestInput(request, operation)).toEqual({ quoteId: "quote-1", idempotencyKey: "replay-1" });
  const bodyRequest = {
    body: { idempotencyKey: "body-value" },
    query: {},
    params: { quoteId: "quote-1" },
    headers: { "idempotency-key": "replay-1" },
  } as never;
  expect(() => operationRestInput(bodyRequest, operation))
    .toThrow(/must only be supplied through/);
});
