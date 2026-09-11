// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { operationFailure } from "@openshapeforge/operations";
import { GraphQLError } from "graphql";
import { toHttpError } from "../rest/http-error.js";
import { projectGraphqlOperation } from "./operation-error.js";

test("GraphQL projects a canonical operation failure at its boundary", async () => {
  const retryAt = "2026-09-11T15:15:00.000Z";
  const caught = await projectGraphqlOperation(() => {
    throw operationFailure({
      code: "REFERENCE_IN_USE",
      message: "This relation is still in use.",
      detail: "Remove the active reference first.",
      retryable: true,
      retryAt,
    });
  }).catch((error) => error);

  expect(caught).toBeInstanceOf(GraphQLError);
  expect(caught).toMatchObject({
    message: "This relation is still in use.",
    extensions: {
      code: "REFERENCE_IN_USE",
      status: 409,
      retryable: true,
      retryAt,
    },
  });
});

test("canonical operation codes retain their intended HTTP meaning", async () => {
  for (const [code, status] of [
    ["VALIDATION", 422],
    ["LOCKED", 423],
    ["VERSION_CONFLICT", 409],
    ["ASSESSMENT_LOCKED", 409],
  ] as const) {
    const failure = operationFailure({ code, message: "Safe refusal." });
    expect(toHttpError(failure).status).toBe(status);
    const caught = await projectGraphqlOperation(() => {
      throw failure;
    }).catch((error) => error);
    expect(caught).toMatchObject({ extensions: { code, status } });
  }
});
