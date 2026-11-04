// SPDX-License-Identifier: BUSL-1.1
import { expect, mock, test } from "bun:test";

class GraphqlProxyError extends Error {
  constructor(message: string, readonly status: number, readonly payload?: unknown) {
    super(message);
  }
}
let answer: () => Promise<unknown> = async () => ({});
mock.module("@/lib/server/graphql-client", () => ({
  executeGraphqlRequest: () => answer(),
  isGraphqlProxyError: (error: unknown) => error instanceof GraphqlProxyError,
}));
const { POST } = await import("./route");

const request = () => new Request("http://web.test/api/entity/delete", {
  method: "POST",
  body: JSON.stringify({
    mutationName: "deleteRelation",
    id: "6180f0f3-b637-4b9b-ac44-eb00cf30570a",
    expectedVersion: "2026-11-03T10:00:00.000Z",
    confirmed: true,
  }),
});

test("a delete taken over by an operation override answers 202 with the acceptance", async () => {
  const accepted = { by: { kind: "workflow", ref: "run-5" }, status: "waiting" };
  answer = async () => {
    throw new GraphqlProxyError("Started workflow run-5", 200, {
      errors: [{ message: "Started", extensions: { code: "OPERATION_ACCEPTED", accepted } }],
    });
  };
  const response = await POST(request());
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ accepted });
});

test("other GraphQL failures still fail, and a real deletion still answers deleted", async () => {
  answer = async () => {
    throw new GraphqlProxyError("Forbidden", 403, { errors: [{ message: "No", extensions: { code: "FORBIDDEN" } }] });
  };
  await expect(POST(request())).rejects.toThrow("Forbidden");
  answer = async () => ({ deleteRelation: { data: { deleted: true } } });
  expect(await (await POST(request())).json()).toEqual({ deleted: true });
});
