// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { acceptanceFromGraphqlPayload, acceptanceMessage, isOperationAcceptance } from "./operation-acceptance";

const accepted = { by: { kind: "workflow", ref: "run-3" }, status: "waiting" as const };

test("reads the acceptance from a GraphQL OPERATION_ACCEPTED error and nothing else", () => {
  expect(acceptanceFromGraphqlPayload({ errors: [{ message: "Started", extensions: { code: "OPERATION_ACCEPTED", accepted } }] }))
    .toEqual(accepted);
  expect(acceptanceFromGraphqlPayload({ errors: [{ message: "No", extensions: { code: "FORBIDDEN" } }] })).toBeUndefined();
  expect(acceptanceFromGraphqlPayload({ errors: [{ extensions: { code: "OPERATION_ACCEPTED", accepted: { by: {} } } }] })).toBeUndefined();
  expect(acceptanceFromGraphqlPayload(null)).toBeUndefined();
  expect(isOperationAcceptance({ ...accepted, status: "deleted" })).toBe(false);
});

test("says started, not done", () => {
  expect(acceptanceMessage(accepted, "nl")).toContain("Gestart: workflow run-3");
  expect(acceptanceMessage({ ...accepted, status: "completed" }, "en")).toBe("Handled by workflow run-3.");
});
