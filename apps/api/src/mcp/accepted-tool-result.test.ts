// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { GraphQLError } from "graphql";
import { acceptedToolResult, runtimeOperationToolResult } from "./tool-results.js";
import { projectAcceptedGraphqlMutation } from "../graphql/generated-entity-schema.js";

const accepted = { by: { kind: "workflow", ref: "run-7" }, status: "waiting" as const };

test("MCP carries a taken-over Operation as structured acceptance with an honest text", () => {
  const result = runtimeOperationToolResult({ intent: "delete", accepted, operations: [] });
  expect(result.isError).toBeUndefined();
  expect(result.structuredContent).toEqual({ accepted, operations: [] });
  expect(result.content).toEqual([
    { type: "text", text: "Started workflow run-7; the change happens when it completes." },
  ]);
  expect(acceptedToolResult({ accepted: { ...accepted, status: "completed" }, operations: [] }).content[0])
    .toMatchObject({ text: expect.stringContaining("Handled by workflow run-7") });
});

test("GraphQL projects acceptance as an OPERATION_ACCEPTED error and passes other results through", () => {
  const ordinary = { intent: "delete" as const, data: { deleted: true }, operations: [] };
  expect(projectAcceptedGraphqlMutation(ordinary)).toBe(ordinary);
  let caught: unknown;
  try {
    projectAcceptedGraphqlMutation({ intent: "delete", accepted, operations: [] });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(GraphQLError);
  expect((caught as GraphQLError).extensions).toEqual({ code: "OPERATION_ACCEPTED", accepted });
});
