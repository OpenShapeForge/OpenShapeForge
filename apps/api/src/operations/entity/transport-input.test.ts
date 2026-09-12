// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import type { EntityOperationContract } from "./types.js";
import { pluginEntityTransportInput } from "./transport-input.js";

const operation = { target: { scope: "record", inputField: "headId" }, reliability: { idempotency: { mode: "keyed", inputField: "requestKey" } } } as EntityOperationContract;
test("plugin CRUD transports keep authored fields without inventing a values wrapper", () => {
  const input = { definition: { title: "Draft" }, expectedVersion: "version", leaseToken: "lease" };
  expect(pluginEntityTransportInput(operation, input, "head", "key")).toEqual({ ...input, headId: "head", requestKey: "key" });
  expect(input).not.toHaveProperty("requestKey");
});
test("URL and key bindings cannot disagree with the body", () => {
  expect(() => pluginEntityTransportInput(operation, { headId: "different" }, "head")).toThrow();
  expect(() => pluginEntityTransportInput(operation, { requestKey: "different" }, "head", "key")).toThrow();
  expect(() => pluginEntityTransportInput(operation, [], "head")).toThrow();
});
