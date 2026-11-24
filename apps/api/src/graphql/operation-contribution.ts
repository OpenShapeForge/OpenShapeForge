// SPDX-License-Identifier: BUSL-1.1
import { TRANSITIONS_PLUGIN } from "../operations/entity/transitions.js";
import { JOBS_PLUGIN } from "../jobs/operations.js";
import { GraphQLError } from "graphql";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { GraphqlContext } from "./context.js";
import type {
  ModuleGraphqlContribution,
  ModuleRuntimeContext,
  RuntimeModule,
} from "../modules/contract.js";
import { operationFailure } from "@openshapeforge/operations";
import { withModuleOperationSession } from "../modules/platform.js";
import { isWithheldOperation } from "../operations/entity/runtime.js";
import { HttpError, toHttpError } from "../rest/http-error.js";
import { BILLING_PLUGIN } from "../operations/billing/module.js";
import { EXTENSIONS_PLUGIN } from "../operations/entity/extensions/operations.js";
import { addressable, executeForCaller } from "../operations/caller-projection.js";
import { bindOperationHandlers } from "../operations/composition.js";
import {
  asInput,
  invokeOperation,
  listOperationContracts,
  DeclaredOperationError,
} from "../operations/runtime.js";

export function operationGraphqlContribution(
  modules: readonly RuntimeModule[],
  runtime: ModuleRuntimeContext,
): RuntimeModule | undefined {
  // The core jobs, transition, billing and tenant field Operations project in
  // every process, as their REST and MCP surfaces do: the handlers ship with
  // the runtime, not with a module.
  const activePlugins = new Set([...modules.map((module) => module.name), JOBS_PLUGIN, TRANSITIONS_PLUGIN, BILLING_PLUGIN, EXTENSIONS_PLUGIN]);
  const projected = listOperationContracts().filter((operation) =>
    (activePlugins.has(operation.plugin) || operation.implementation?.type === "ownedDelete") && operation.transports.graphql.enabled
  );
  if (projected.length === 0 && !runtime.platform) return undefined;
  const bound = projected.length > 0 ? bindOperationHandlers(modules) : new Map();
  const runtimeQueryFields = runtime.platform
    ? [
        "operationCatalog: JSON!",
        "operationDefinition(id: String!): JSON",
      ]
    : [];
  const runtimeMutationFields = runtime.platform
    ? [
        "executeOperation(id: String!, intent: String!, input: JSON, idempotencyKey: String): JSON!",
      ]
    : [];
  const queryFields = [
    ...runtimeQueryFields,
    ...projected
      .filter((operation) => operation.transports.graphql.kind === "query")
      .map((operation) => `${operation.transports.graphql.field}(input: JSON!): JSON!`),
  ].join("\n");
  const mutationFields = [
    ...runtimeMutationFields,
    ...projected
      .filter((operation) => operation.transports.graphql.kind === "mutation")
      .map((operation) => `${operation.transports.graphql.field}(input: JSON!): JSON!`),
  ].join("\n");
  const resolvers = { Query: {} as Record<string, unknown>, Mutation: {} as Record<string, unknown> };
  const withRuntimeSession = async <T>(
    context: GraphqlContext,
    work: (session: TrustedSessionContext) => Promise<T>,
  ): Promise<T> => {
    if (!runtime.platform || !context.session?.userId) {
      throw new HttpError(
        401,
        "UNAUTHENTICATED",
        "Operation discovery requires an authenticated session.",
      );
    }
    return withModuleOperationSession(
      runtime.platform,
      context.session,
      (session) => work(session!),
    );
  };
  if (runtime.platform) {
    resolvers.Query.operationCatalog = (
      _parent: unknown,
      _args: unknown,
      context: GraphqlContext,
    ) => withRuntimeSession(
      context,
      async (session) => addressable(await runtime.platform!.operations.list(session)),
    );
    resolvers.Query.operationDefinition = (
      _parent: unknown,
      args: { id: string },
      context: GraphqlContext,
    ) => withRuntimeSession(
      context,
      async (session) => isWithheldOperation(args.id) ? undefined : runtime.platform!.operations.get(session, args.id),
    );
    resolvers.Mutation.executeOperation = (
      _parent: unknown,
      args: {
        id: string;
        intent: string;
        input?: unknown;
        idempotencyKey?: string;
      },
      context: GraphqlContext,
    ) => withRuntimeSession(context, (session) => {
      const input = args.input === undefined ? undefined : asInput(args.input);
      return executeForCaller(runtime.platform!, session, {
        operation: { id: args.id, intent: args.intent },
        ...(input ? { input } : {}),
        ...(args.idempotencyKey
          ? { idempotencyKey: args.idempotencyKey }
          : {}),
      });
    });
  }
  for (const operation of projected) {
    const target = operation.transports.graphql.kind === "query" ? resolvers.Query : resolvers.Mutation;
    target[operation.transports.graphql.field!] = async (_parent: unknown, args: { input: unknown }, context: GraphqlContext) => {
      try {
        if (operation.idempotency.mode === "idempotency-key" && (!runtime.db || !runtime.platform)) {
          throw operationFailure({
            code: "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
            message: "The Operation cannot persist its required idempotency receipt.",
            retryable: true,
          });
        }
        return (await invokeOperation(bound.get(operation.key)!, args.input, {
          ...runtime,
          transport: "graphql",
          session: context.session,
        })).value;
      } catch (error) {
        if (error instanceof DeclaredOperationError) {
          throw new GraphQLError(error.message, {
            extensions: { code: error.code, status: error.status, body: error.body },
          });
        }
        const { status, body } = toHttpError(error);
        throw new GraphQLError(body.error.message, { extensions: { code: body.error.code, status, retryable: body.error.retryable } });
      }
    };
  }
  const contribution: ModuleGraphqlContribution = { queryFields, mutationFields, resolvers };
  return { name: "__canonical_operations", graphql: () => contribution };
}
