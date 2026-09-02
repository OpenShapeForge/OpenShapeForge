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
    await expect(invokeOperation(bound, {
      definitionId: "not-a-uuid",
      idempotencyKey: "webhook-invalid",
    }, { transport: "graphql", session })).rejects.toMatchObject({ status: 400 });
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
    expect(() => requireOperationAuthorization(operation, {
      ...session,
      credential: "api-key",
      oauthScopes: ["workflow:write"],
    })).toThrow(/cannot be invoked with an API key/);
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

  test("caches one immutable handler binding per initialized module set", () => {
    const modules: RuntimeModule[] = [{
      name: "workflow",
      operationHandlers: { startWebhook: async () => ({ value: {} }) },
    }];
    expect(bindOperationHandlers(modules)).toBe(bindOperationHandlers(modules));
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
  const emptyBodyRequest = {
    body: new Uint8Array(),
    query: { utm_source: "sender" },
    params: { quoteId: "quote-1" },
    headers: { "idempotency-key": "replay-2" },
  } as never;
  expect(operationRestInput(emptyBodyRequest, operation)).toEqual({ quoteId: "quote-1", idempotencyKey: "replay-2" });
  const collidingQueryRequest = {
    body: {},
    query: { idempotencyKey: "query-value" },
    params: { quoteId: "quote-1" },
    headers: { "idempotency-key": "replay-3" },
  } as never;
  expect(() => operationRestInput(collidingQueryRequest, operation)).toThrow(/query parameters/);
});

test("REST coerces typed GET and DELETE query values before canonical validation", () => {
  const operation = {
    key: "demo.quote.list",
    inputSchema: {
      type: "object",
      required: ["limit", "enabled"],
      properties: { limit: { type: "integer" }, enabled: { type: "boolean" } },
      additionalProperties: false,
    },
    idempotency: { mode: "none" },
    transports: { rest: { method: "GET", path: "/api/demo/quotes" } },
  } as unknown as OperationContract;
  const request = {
    body: undefined,
    query: { limit: "5", enabled: "true" },
    params: {},
    headers: {},
  } as never;
  expect(operationRestInput(request, operation)).toEqual({ limit: 5, enabled: true });
});
