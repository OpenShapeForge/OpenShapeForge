// SPDX-License-Identifier: BUSL-1.1
/**
 * The workflow module's GraphQL surface.
 *
 * Contributed through `RuntimeModule.graphql`, so `apps/api` names none of it:
 * the schema is assembled from whatever modules are registered, and a
 * deployment without this plugin simply has no workflow fields.
 *
 * ## Why these are not generated CRUD
 *
 * The `workflow.*` tables are declared `domainInternal`, which keeps the
 * generic entity engine away from them, and that is deliberate. The engine
 * would happily expose `createWorkflowDefinition` as a flat column write —
 * and every invariant that makes a definition meaningful lives above the
 * columns. Publishing versions the graph and validates it against the node
 * catalog. Saving checks an optimistic-concurrency token. Deleting refuses
 * when runs exist. An ACL decides who may do any of it. None of that is
 * expressible as a column, so the resolvers own it.
 *
 * ## Errors carry a code, not a message
 *
 * Every module function throws `WorkflowDefinitionError` with a code from a
 * closed union, and `runDefinitionOperation` maps that onto
 * `extensions.code`. Callers branch on the code; the message is for humans and
 * free to change. A resolver that let a raw error escape would hand a client a
 * Postgres string to match on, which is how an internal detail becomes an API.
 */
import type { OpenShapeForgeDatabase } from "../../../../apps/api/src/db/connection.js";
import type { Json } from "../../../../apps/api/src/generated/db/types.js";
import {
  acquireWorkflowDefinitionLock,
  getWorkflowDefinitionLock,
  releaseWorkflowDefinitionLock,
  stealWorkflowDefinitionLock,
} from "./definition-locks.js";
import {
  archiveWorkflowDefinition,
  createWorkflowDefinition,
  deleteWorkflowDefinitionPermanently,
  publishWorkflowDefinitionVersion,
  saveWorkflowDefinitionVersion,
  updateWorkflowDefinition,
} from "./definition-mutations.js";
import { patchWorkflowDefinition } from "./definition-patch.js";
import {
  getLatestPublishedWorkflowDefinitionVersion,
  getWorkflowDefinition,
  getWorkflowDefinitionVersion,
  listPublishedWorkflowDefinitions,
  listWorkflowDefinitions,
  listWorkflowDefinitionVersions,
} from "./definitions.js";
import { WorkflowDefinitionError } from "./definition-types.js";
import { validateWorkflowDefinition } from "./definition-validation.js";
import { getEntityDetail, getEntityPalette } from "./entity-catalog.js";
import {
  getEntityTriggerFilterFields,
  getEntityTriggerOptions,
} from "./entity-trigger-registry.js";
import { getWorkflowNodeType, listWorkflowNodeTypes } from "./node-catalog.js";
import { WORKFLOW_NODE_RUNTIME_SUPPORT_ENUM_VALUES } from "./node-executability.js";

/** Enough of the API's GraphQL context to serve these fields. */
type WorkflowGraphqlContext = {
  db?: OpenShapeForgeDatabase | undefined;
  session?:
    | {
        tenantId?: string | null;
        userId?: string | null;
        roles?: readonly string[];
        groups?: readonly string[];
      }
    | undefined;
};

/** A GraphQLError-shaped throw, without importing graphql into the plugin. */
function graphqlError(code: string, message: string, status: number): Error {
  const error = new Error(message) as Error & { extensions: Record<string, unknown> };
  error.extensions = { code, status };
  return error;
}

/**
 * Every workflow field is tenant data, so an anonymous caller gets nothing —
 * not an empty list, which would read as "this tenant has no workflows".
 */
function requireSession(context: WorkflowGraphqlContext) {
  const session = context.session;
  if (!session?.tenantId || !session?.userId) {
    throw graphqlError("UNAUTHENTICATED", "Workflow access requires an authenticated session.", 401);
  }
  if (!context.db) {
    throw graphqlError("DATABASE_NOT_CONFIGURED", "Workflow access requires a database.", 503);
  }
  return {
    db: context.db,
    session: {
      tenantId: session.tenantId,
      userId: session.userId,
      roles: [...(session.roles ?? [])],
      groups: [...(session.groups ?? [])],
    },
  };
}

/** Translate the module's error codes into GraphQL extensions codes. */
async function runDefinitionOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof WorkflowDefinitionError) {
      const status =
        error.code === "NOT_FOUND"
          ? 404
          : error.code === "FORBIDDEN"
            ? 403
            : error.code === "CONFLICT" ||
                error.code === "CONCURRENT_MODIFICATION" ||
                error.code === "LOCK_HELD"
              ? 409
              : 400;
      throw graphqlError(error.code, error.message, status);
    }
    throw error;
  }
}

export const workflowTypeDefs = /* GraphQL */ `
  enum WorkflowDefinitionCategory {
    process
    orchestrator
  }

  """
  A workflow definition's identity and metadata. The graph itself lives on a
  version; a list read must not carry every document.
  """
  type WorkflowDefinition {
    id: ID!
    name: String!
    description: String
    category: WorkflowDefinitionCategory!
    parentDefinitionId: ID
    parentNodeId: String
    externalId: String
    isActive: Boolean!
    createdAt: String!
    "Doubles as the optimistic-concurrency token on saveWorkflowDefinitionVersion."
    updatedAt: String!
    "Trigger node types on the published graph, so a list can be filtered by trigger."
    triggerTypes: [String!]!
    publishedVersion: Int
    latestVersion: Int
  }

  type WorkflowDefinitionVersion {
    id: ID!
    definitionId: ID!
    version: Int!
    definition: JSON!
    publishedAt: String
    publishedBy: ID
    changelog: String
    createdAt: String!
  }

  "A version without its graph, for listing history cheaply."
  type WorkflowDefinitionVersionSummary {
    id: ID!
    definitionId: ID!
    version: Int!
    publishedAt: String
    publishedBy: ID
    changelog: String
    createdAt: String!
  }

  type WorkflowDefinitionValidationIssue {
    severity: String!
    code: String!
    message: String!
    path: String!
    nodeId: String
    edgeId: String
  }

  """
  valid is false only when at least one issue is an error, which is what
  publishing refuses on. Warnings are reported and never refuse anything.
  Saving a draft does not validate at all, so a broken graph can always be
  stored and shown with its problems attached.
  """
  type WorkflowDefinitionValidationResult {
    valid: Boolean!
    issues: [WorkflowDefinitionValidationIssue!]!
  }

  type WorkflowDefinitionPatchResult {
    dryRun: Boolean!
    definition: JSON!
    validation: WorkflowDefinitionValidationResult!
    savedDefinition: WorkflowDefinition
    publishedVersion: WorkflowDefinitionVersion
  }

  type WorkflowDefinitionLock {
    definitionId: ID!
    lockToken: String!
    ownerUserId: ID!
    acquiredAt: String!
    expiresAt: String!
  }

  "Whether this deployment can run a node type. See runtime/node-executability.ts."
  enum WorkflowNodeRuntimeSupport {
    "A bridge is registered, or the runtime handles the type natively."
    EXECUTABLE
    "In the catalog with no bridge here; a host repo can supply one."
    UNIMPLEMENTED
    "The engine cannot run it as designed. A bridge would not help."
    UNSUPPORTED
  }

  type WorkflowNodeType {
    type: String!
    "Which pack authored it: standard, entity or domain. Provenance, not capability."
    catalog: String!
    category: String!
    "Localized; the client picks a locale."
    label: JSON!
    description: JSON
    configFields: JSON!
    outputFields: JSON!
    "What a palette gates on. Placing a non-EXECUTABLE node yields a graph that fails at run time."
    runtimeSupport: WorkflowNodeRuntimeSupport!
  }

  type WorkflowEntityNodePaletteEntry {
    type: String!
    action: String!
    category: String!
    label: JSON!
    description: JSON
  }

  type WorkflowEntityNodeDetail {
    type: String!
    action: String!
    configFields: JSON!
    outputFields: JSON!
    defaultConfig: JSON!
  }

  type WorkflowEntityTriggerOption {
    id: ID!
    module: String!
    entity: String!
    entityType: String!
    domains: JSON!
    label: JSON!
  }

  input CreateWorkflowDefinitionInput {
    name: String!
    description: String
    category: WorkflowDefinitionCategory
    authorization: JSON
  }

  input UpdateWorkflowDefinitionInput {
    definitionId: ID!
    name: String
    description: String
    category: WorkflowDefinitionCategory
    authorization: JSON
  }

  input SaveWorkflowDefinitionVersionInput {
    definitionId: ID!
    "The definition's updatedAt as last read; a stale token is refused."
    expectedUpdatedAt: String!
    definition: JSON!
    changelog: String
  }

  input PublishWorkflowDefinitionVersionInput {
    definitionId: ID!
    version: Int!
  }

  input PatchWorkflowDefinitionInput {
    definitionId: ID!
    expectedUpdatedAt: String!
    operations: [JSON!]!
    "Return the resulting graph and its issues without writing."
    dryRun: Boolean
    publish: Boolean
    changelog: String
  }
`;

export const workflowQueryFields = /* GraphQL */ `
  workflowDefinitions(category: WorkflowDefinitionCategory, categories: [WorkflowDefinitionCategory!], search: String): [WorkflowDefinition!]!
  publishedWorkflowDefinitions(category: WorkflowDefinitionCategory, categories: [WorkflowDefinitionCategory!], search: String): [WorkflowDefinition!]!
  workflowDefinition(id: ID!): WorkflowDefinition
  workflowDefinitionVersion(definitionId: ID!, version: Int!): WorkflowDefinitionVersion
  latestPublishedWorkflowDefinitionVersion(definitionId: ID!): WorkflowDefinitionVersion
  workflowDefinitionVersions(definitionId: ID!): [WorkflowDefinitionVersionSummary!]!
  workflowDefinitionLock(definitionId: ID!): WorkflowDefinitionLock
  workflowNodeTypes: [WorkflowNodeType!]!
  workflowNodeType(type: String!): WorkflowNodeType
  workflowEntityNodePalette: [WorkflowEntityNodePaletteEntry!]!
  workflowEntityNodeDetail(type: String!): WorkflowEntityNodeDetail
  workflowEntityTriggerOptions: [WorkflowEntityTriggerOption!]!
  workflowEntityTriggerFilterFields(module: String!, entityType: String!): JSON
`;

export const workflowMutationFields = /* GraphQL */ `
  createWorkflowDefinition(input: CreateWorkflowDefinitionInput!): WorkflowDefinition!
  updateWorkflowDefinition(input: UpdateWorkflowDefinitionInput!): WorkflowDefinition!
  saveWorkflowDefinitionVersion(input: SaveWorkflowDefinitionVersionInput!): WorkflowDefinition!
  publishWorkflowDefinitionVersion(input: PublishWorkflowDefinitionVersionInput!): WorkflowDefinitionVersion!
  patchWorkflowDefinition(input: PatchWorkflowDefinitionInput!): WorkflowDefinitionPatchResult!
  validateWorkflowDefinition(definition: JSON!): WorkflowDefinitionValidationResult!
  archiveWorkflowDefinition(definitionId: ID!): WorkflowDefinition!
  deleteWorkflowDefinitionPermanently(definitionId: ID!): Boolean!
  acquireWorkflowDefinitionLock(definitionId: ID!): WorkflowDefinitionLock!
  releaseWorkflowDefinitionLock(definitionId: ID!, lockToken: String!): Boolean!
  stealWorkflowDefinitionLock(definitionId: ID!): WorkflowDefinitionLock!
`;

type Args = Record<string, never>;

export const workflowResolvers = {
  // An enum value map, not a field resolver: it tells graphql-js that the
  // SCREAMING_CASE member `EXECUTABLE` carries the internal value the runtime
  // actually returns. Without it every `runtimeSupport` read would fail to
  // serialize, because "executable" is not the name of an enum member.
  WorkflowNodeRuntimeSupport: WORKFLOW_NODE_RUNTIME_SUPPORT_ENUM_VALUES,

  Query: {
    workflowDefinitions: (
      _p: unknown,
      args: { category?: string; categories?: string[]; search?: string },
      context: WorkflowGraphqlContext,
    ) => {
      const { db, session } = requireSession(context);
      return runDefinitionOperation(() => listWorkflowDefinitions(db, session, args));
    },
    publishedWorkflowDefinitions: (
      _p: unknown,
      args: { category?: string; categories?: string[]; search?: string },
      context: WorkflowGraphqlContext,
    ) => {
      const { db, session } = requireSession(context);
      return runDefinitionOperation(() => listPublishedWorkflowDefinitions(db, session, args));
    },
    workflowDefinition: (_p: unknown, args: { id: string }, context: WorkflowGraphqlContext) => {
      const { db, session } = requireSession(context);
      return runDefinitionOperation(() => getWorkflowDefinition(db, session, args.id));
    },
    workflowDefinitionVersion: (
      _p: unknown,
      args: { definitionId: string; version: number },
      context: WorkflowGraphqlContext,
    ) => {
      const { db, session } = requireSession(context);
      return runDefinitionOperation(() =>
        getWorkflowDefinitionVersion(db, session, args.definitionId, args.version),
      );
    },
    latestPublishedWorkflowDefinitionVersion: (
      _p: unknown,
      args: { definitionId: string },
      context: WorkflowGraphqlContext,
    ) => {
      const { db, session } = requireSession(context);
      return runDefinitionOperation(() =>
        getLatestPublishedWorkflowDefinitionVersion(db, session, args.definitionId),
      );
    },
    workflowDefinitionVersions: (
      _p: unknown,
      args: { definitionId: string },
      context: WorkflowGraphqlContext,
    ) => {
      const { db, session } = requireSession(context);
      return runDefinitionOperation(() =>
        listWorkflowDefinitionVersions(db, session, args.definitionId),
      );
    },
    workflowDefinitionLock: (
      _p: unknown,
      args: { definitionId: string },
      context: WorkflowGraphqlContext,
    ) => {
      const { db, session } = requireSession(context);
      return runDefinitionOperation(() =>
        getWorkflowDefinitionLock(db, session, args.definitionId),
      );
    },

    // The catalogs are global compiler output, identical for every tenant, but
    // still session-gated: they describe what this deployment can do, which is
    // not something to hand an anonymous caller.
    workflowNodeTypes: (_p: unknown, _a: Args, context: WorkflowGraphqlContext) => {
      requireSession(context);
      return listWorkflowNodeTypes();
    },
    workflowNodeType: (_p: unknown, args: { type: string }, context: WorkflowGraphqlContext) => {
      requireSession(context);
      return getWorkflowNodeType(args.type);
    },
    workflowEntityNodePalette: (_p: unknown, _a: Args, context: WorkflowGraphqlContext) => {
      const { db } = requireSession(context);
      return getEntityPalette(db);
    },
    workflowEntityNodeDetail: (
      _p: unknown,
      args: { type: string },
      context: WorkflowGraphqlContext,
    ) => {
      const { db } = requireSession(context);
      return getEntityDetail(db, args.type);
    },
    workflowEntityTriggerOptions: (_p: unknown, _a: Args, context: WorkflowGraphqlContext) => {
      const { db } = requireSession(context);
      return getEntityTriggerOptions(db);
    },
    workflowEntityTriggerFilterFields: (
      _p: unknown,
      args: { module: string; entityType: string },
      context: WorkflowGraphqlContext,
    ) => {
      const { db } = requireSession(context);
      return getEntityTriggerFilterFields(db, args.module, args.entityType);
    },
  },

  Mutation: {
    createWorkflowDefinition: (
      _p: unknown,
      args: { input: { name: string; description?: string; category?: string; authorization?: Json } },
      context: WorkflowGraphqlContext,
    ) => {
      const { db, session } = requireSession(context);
      return runDefinitionOperation(() => createWorkflowDefinition(db, session, args.input));
    },
    updateWorkflowDefinition: (
      _p: unknown,
      args: { input: { definitionId: string } & Record<string, unknown> },
      context: WorkflowGraphqlContext,
    ) => {
      const { db, session } = requireSession(context);
      return runDefinitionOperation(() => updateWorkflowDefinition(db, session, args.input as never));
    },
    saveWorkflowDefinitionVersion: (
      _p: unknown,
      args: {
        input: { definitionId: string; expectedUpdatedAt: string; definition: Json; changelog?: string };
      },
      context: WorkflowGraphqlContext,
    ) => {
      const { db, session } = requireSession(context);
      return runDefinitionOperation(() => saveWorkflowDefinitionVersion(db, session, args.input));
    },
    publishWorkflowDefinitionVersion: (
      _p: unknown,
      args: { input: { definitionId: string; version: number } },
      context: WorkflowGraphqlContext,
    ) => {
      const { db, session } = requireSession(context);
      return runDefinitionOperation(() =>
        publishWorkflowDefinitionVersion(db, session, args.input),
      );
    },
    patchWorkflowDefinition: (
      _p: unknown,
      args: { input: Record<string, unknown> },
      context: WorkflowGraphqlContext,
    ) => {
      const { db, session } = requireSession(context);
      return runDefinitionOperation(() => patchWorkflowDefinition(db, session, args.input as never));
    },
    // Pure: no database, no session state changed. Session-gated anyway,
    // because the node catalog it validates against is deployment information.
    validateWorkflowDefinition: (
      _p: unknown,
      args: { definition: unknown },
      context: WorkflowGraphqlContext,
    ) => {
      requireSession(context);
      return validateWorkflowDefinition(args.definition);
    },
    archiveWorkflowDefinition: (
      _p: unknown,
      args: { definitionId: string },
      context: WorkflowGraphqlContext,
    ) => {
      const { db, session } = requireSession(context);
      return runDefinitionOperation(() => archiveWorkflowDefinition(db, session, args.definitionId));
    },
    deleteWorkflowDefinitionPermanently: (
      _p: unknown,
      args: { definitionId: string },
      context: WorkflowGraphqlContext,
    ) => {
      const { db, session } = requireSession(context);
      return runDefinitionOperation(async () => {
        await deleteWorkflowDefinitionPermanently(db, session, args.definitionId);
        return true;
      });
    },
    acquireWorkflowDefinitionLock: (
      _p: unknown,
      args: { definitionId: string },
      context: WorkflowGraphqlContext,
    ) => {
      const { db, session } = requireSession(context);
      return runDefinitionOperation(() =>
        acquireWorkflowDefinitionLock(db, session, args.definitionId),
      );
    },
    releaseWorkflowDefinitionLock: (
      _p: unknown,
      args: { definitionId: string; lockToken: string },
      context: WorkflowGraphqlContext,
    ) => {
      const { db, session } = requireSession(context);
      return runDefinitionOperation(() =>
        releaseWorkflowDefinitionLock(db, session, args.definitionId, args.lockToken),
      );
    },
    stealWorkflowDefinitionLock: (
      _p: unknown,
      args: { definitionId: string },
      context: WorkflowGraphqlContext,
    ) => {
      const { db, session } = requireSession(context);
      return runDefinitionOperation(() =>
        stealWorkflowDefinitionLock(db, session, args.definitionId),
      );
    },
  },
};
