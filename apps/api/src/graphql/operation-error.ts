// SPDX-License-Identifier: BUSL-1.1
import { operationErrorOf } from "@openshapeforge/operations";
import { GraphQLError } from "graphql";
import { httpStatusForCode } from "../connectors/provider-outcome.js";

/** Project a canonical failure at the GraphQL boundary, never inside core. */
export async function projectGraphqlOperation<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const operationError = operationErrorOf(error);
    if (!operationError) throw error;
    throw new GraphQLError(operationError.message, {
      extensions: {
        code: operationError.code,
        status: httpStatusForCode(operationError.code) ?? 409,
        retryable: operationError.retryable,
        ...(operationError.detail === undefined ? {} : { detail: operationError.detail }),
        ...(operationError.retryAt === undefined ? {} : { retryAt: operationError.retryAt }),
        ...(operationError.violations === undefined
          ? {}
          : { violations: operationError.violations }),
        ...(operationError.data === undefined ? {} : { data: operationError.data }),
      },
    });
  }
}
