// SPDX-License-Identifier: BUSL-1.1
/**
 * Merging module GraphQL contributions into one schema input.
 *
 * Two modules may each add root fields, so `Query` and `Mutation` resolvers are
 * merged per type rather than spread over each other — a plain spread would
 * have the last module silently replace every root field the earlier ones
 * added, and the symptom would be a missing query rather than an error.
 *
 * Collisions are refused at boot. A module whose field name already exists
 * would otherwise shadow it: two plugins both claiming `workflowDefinitions`,
 * or a plugin claiming a generated entity's query name, is a deployment that
 * cannot be reasoned about. Failing at startup makes it a five-second fix
 * instead of a support ticket about the wrong resolver running.
 *
 * This is composition only; it neither imports nor knows about the core
 * schema's own fields. The caller passes those in as reserved names.
 */
import { GraphQLError } from "graphql";
import type { ModuleGraphqlContribution, ModuleRuntimeContext, RuntimeModule } from "./contract.js";

export type ComposedModuleGraphql = {
  typeDefs: string;
  queryFields: string;
  mutationFields: string;
  resolvers: Record<string, Record<string, unknown>>;
};

/** Field names already taken on a root type, so a module cannot shadow them. */
export type ReservedRootFields = {
  query: Iterable<string>;
  mutation: Iterable<string>;
};

export class ModuleCompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModuleCompositionError";
  }
}

/**
 * Field names declared by an SDL fragment of root fields.
 *
 * The fragment is a list of field definitions, not a full type, so a field name
 * is an identifier followed by `(` or `:` — but only at the top level. An
 * argument list spans lines just as often as not:
 *
 *   workflowDefinitions(
 *     first: Int
 *     after: String
 *   ): [WorkflowDefinitionRecord!]!
 *
 * and a line-by-line reading takes `first` and `after` for fields. Those names
 * then join the reserved set, and a module that legitimately declares a `first`
 * query is refused for colliding with an argument. So argument lists are
 * removed before the scan, along with comments and descriptions, which may
 * contain anything at all.
 */
export function declaredFieldNames(fields: string): string[] {
  const withoutDescriptions = fields
    .replace(/"""[\s\S]*?"""/g, " ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, " ")
    .replace(/#[^\n]*/g, " ");

  // Drop argument parentheses and everything in them, newlines included: a
  // multi-line argument list would otherwise leave the field name on its own
  // line, separated from the `:` that identifies it. A parenthesised group
  // cannot span two field declarations, so collapsing it cannot merge fields.
  let depth = 0;
  let topLevel = "";
  for (const char of withoutDescriptions) {
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) topLevel += char;
  }

  const names: string[] = [];
  for (const rawLine of topLevel.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line);
    if (match?.[1]) names.push(match[1]);
  }
  return names;
}

function claimRootFields(
  moduleName: string,
  rootType: "Query" | "Mutation",
  fields: string | undefined,
  taken: Set<string>,
): void {
  for (const field of declaredFieldNames(fields ?? "")) {
    if (taken.has(field)) {
      throw new ModuleCompositionError(
        `Runtime module "${moduleName}" declares ${rootType}.${field}, which is already defined. Two surfaces cannot claim the same root field.`,
      );
    }
    taken.add(field);
  }
}

/**
 * Re-throw a module's error as a real `GraphQLError`, so its code survives the
 * wire.
 *
 * A module has no `graphql` dependency — deliberately, so a plugin can be
 * written without one — and therefore throws a plain `Error` carrying
 * `extensions.code`. graphql-js copies those extensions when it locates the
 * error, so the code is intact for anything calling `graphql()` in process.
 *
 * It does not survive the server. graphql-yoga masks errors by default, and
 * keeps one only when the terminal link of the `originalError` chain is
 * `instanceof GraphQLError`. A plain `Error` is not, so every module error
 * reached a client as `INTERNAL_SERVER_ERROR` / "Unexpected error." — a caller
 * could not tell "you are not signed in" from "the server broke", and could not
 * fall back on the status either, since yoga answers 200 when `data` is present.
 * In-process tests could never have caught it; only a request over HTTP does.
 *
 * Wrapping here rather than in each module keeps the fix in the layer that owns
 * `graphql`, and covers every runtime module rather than the one that noticed.
 *
 * The `originalError` is deliberately NOT threaded onto the wrapper: yoga walks
 * that chain to its end, so a GraphQLError wrapping a plain Error is masked just
 * the same. The wrapper has to be the terminal link.
 */
function wrapModuleResolver(resolver: unknown): unknown {
  if (typeof resolver !== "function") return resolver;
  const fn = resolver as (...args: unknown[]) => unknown;

  const rethrow = (error: unknown): never => {
    if (error instanceof GraphQLError) throw error;
    const extensions =
      error && typeof error === "object" && "extensions" in error
        ? (error as { extensions?: unknown }).extensions
        : undefined;
    if (!extensions || typeof extensions !== "object") throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new GraphQLError(message, {
      extensions: extensions as Record<string, unknown>,
    });
  };

  return (...args: unknown[]) => {
    try {
      const result = fn(...args);
      return result instanceof Promise ? result.catch(rethrow) : result;
    } catch (error) {
      return rethrow(error);
    }
  };
}

export function composeModuleGraphql(
  modules: readonly RuntimeModule[],
  context: ModuleRuntimeContext,
  reserved: ReservedRootFields,
): ComposedModuleGraphql {
  const typeDefs: string[] = [];
  const queryFields: string[] = [];
  const mutationFields: string[] = [];
  const resolvers: Record<string, Record<string, unknown>> = {};

  const takenQuery = new Set(reserved.query);
  const takenMutation = new Set(reserved.mutation);

  for (const module of modules) {
    const contribution: ModuleGraphqlContribution = module.graphql?.(context) ?? {};

    claimRootFields(module.name, "Query", contribution.queryFields, takenQuery);
    claimRootFields(module.name, "Mutation", contribution.mutationFields, takenMutation);

    if (contribution.typeDefs?.trim()) typeDefs.push(contribution.typeDefs.trim());
    if (contribution.queryFields?.trim()) queryFields.push(contribution.queryFields.trimEnd());
    if (contribution.mutationFields?.trim()) {
      mutationFields.push(contribution.mutationFields.trimEnd());
    }

    for (const [typeName, fieldResolvers] of Object.entries(contribution.resolvers ?? {})) {
      const target = (resolvers[typeName] ??= {});
      for (const [fieldName, resolver] of Object.entries(fieldResolvers)) {
        // Non-root types are namespaced per module by convention, so a clash
        // here is the same mistake as a root clash and gets the same answer.
        if (fieldName in target) {
          throw new ModuleCompositionError(
            `Runtime module "${module.name}" defines a resolver for ${typeName}.${fieldName}, which another module already defines.`,
          );
        }
        target[fieldName] = wrapModuleResolver(resolver);
      }
    }
  }

  return {
    typeDefs: typeDefs.join("\n\n"),
    queryFields: queryFields.join("\n"),
    mutationFields: mutationFields.join("\n"),
    resolvers,
  };
}
