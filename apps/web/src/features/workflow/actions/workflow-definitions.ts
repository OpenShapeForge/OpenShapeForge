// SPDX-License-Identifier: BUSL-1.1
"use server";
/**
 * The designer's transport. Server actions, because there is no other door.
 *
 * `lib/server/graphql-client.ts` is `server-only`, the app declares no rewrite
 * to the API, and in local development the browser cannot reach the API's port
 * at all — so a client component has no way to run a GraphQL operation itself.
 * The established shape is a server component passing a server action reference
 * into a client component, as `actions/generated/*.ts` and
 * `hooks/use-infinite-list.ts` already do, and this is that for the workflow
 * definition surface.
 *
 * Deliberately thin. Every one of these is a query string and a return, with no
 * decision in it: `apps/web` has no test runner, so anything that could be
 * wrong lives in `examples/plugins/workflow/web/`, where `bun test examples`
 * reaches it. What is left here has nothing to test beyond "it sends the
 * operation", which the e2e suite covers against a real API.
 *
 * ## Failure is returned, not thrown
 *
 * A rejected server action reaches the client as a redacted digest — the actual
 * message is dropped in production — and every error these operations can raise
 * is one the author needs to read: STALE_DEFINITION means somebody else saved,
 * LOCK_HELD names who holds it, a validation refusal lists what is wrong. So
 * each action returns a discriminated result and the caller renders the
 * message.
 */
import {
  executeGraphqlRequest,
  isGraphqlProxyError,
} from "@/lib/server/graphql-client";

export type WorkflowActionResult<TValue> =
  | { ok: true; value: TValue }
  | { ok: false; error: string };

export type WorkflowDefinitionSummary = {
  id: string;
  name: string;
  description: string | null;
  /** Doubles as the optimistic-concurrency token on a save. */
  updatedAt: string;
  publishedVersion: number | null;
  latestVersion: number | null;
};

/**
 * A row in the definition list.
 *
 * `triggerTypes` is the trigger node types on the PUBLISHED graph, and the API
 * derives it by reading that graph in full — so it is asked for on the list read
 * and nowhere else. Putting it on {@link WorkflowDefinitionSummary} would make
 * every save and every publish pay for a document neither of them looks at.
 */
export type WorkflowDefinitionListEntry = WorkflowDefinitionSummary & {
  triggerTypes: string[];
};

export type WorkflowDefinitionVersionView = {
  version: number;
  definition: unknown;
  publishedAt: string | null;
};

export type WorkflowValidationIssueView = {
  severity: string;
  blocksAt: string | null;
  code: string;
  message: string;
  path: string;
  nodeId: string | null;
  edgeId: string | null;
};

export type WorkflowDefinitionLockView = {
  definitionId: string;
  lockToken: string;
  ownerUserId: string;
  acquiredAt: string;
  expiresAt: string;
};

const DEFINITION_FIELDS = `id name description updatedAt publishedVersion latestVersion`;
const DEFINITION_LIST_FIELDS = `${DEFINITION_FIELDS} triggerTypes`;
const ISSUE_FIELDS = `severity blocksAt code message path nodeId edgeId`;
const LOCK_FIELDS = `definitionId lockToken ownerUserId acquiredAt expiresAt`;

export async function listWorkflowDefinitions(): Promise<
  WorkflowActionResult<WorkflowDefinitionListEntry[]>
> {
  return run(async () => {
    const data = await executeGraphqlRequest<{
      workflowDefinitions: WorkflowDefinitionListEntry[];
    }>({
      query: `query WorkflowDefinitions { workflowDefinitions { ${DEFINITION_LIST_FIELDS} } }`,
    });
    return data.workflowDefinitions ?? [];
  });
}

export async function createWorkflowDefinition(
  name: string,
): Promise<WorkflowActionResult<WorkflowDefinitionSummary>> {
  return run(async () => {
    const data = await executeGraphqlRequest<{
      createWorkflowDefinition: WorkflowDefinitionSummary;
    }>({
      query: `mutation CreateWorkflowDefinition($input: CreateWorkflowDefinitionInput!) {
        createWorkflowDefinition(input: $input) { ${DEFINITION_FIELDS} }
      }`,
      variables: { input: { name } },
    });
    return data.createWorkflowDefinition;
  });
}

/**
 * Rename a definition.
 *
 * `updateWorkflowDefinition` also carries description, category and the ACL;
 * only the name is exposed here because only the name is on the list screen,
 * and an action that could write four fields when the caller means one is an
 * action whose blast radius does not match its name. The rest belongs to the
 * settings sheet, which is its own slice.
 *
 * Renaming stamps `updated_at`, which is the optimistic-concurrency token an
 * open editor is holding — so a rename made while somebody is editing costs
 * them their next save. That is the API's semantics rather than this action's,
 * and the caller refuses a no-op rename so the cost is at least never paid for
 * nothing.
 */
export async function renameWorkflowDefinition(input: {
  definitionId: string;
  name: string;
}): Promise<WorkflowActionResult<WorkflowDefinitionSummary>> {
  return run(async () => {
    const data = await executeGraphqlRequest<{
      updateWorkflowDefinition: WorkflowDefinitionSummary;
    }>({
      query: `mutation RenameWorkflowDefinition($input: UpdateWorkflowDefinitionInput!) {
        updateWorkflowDefinition(input: $input) { ${DEFINITION_FIELDS} }
      }`,
      variables: { input: { definitionId: input.definitionId, name: input.name } },
    });
    return data.updateWorkflowDefinition;
  });
}

/**
 * Archive a definition: `is_active = false`, and every read filters on it.
 *
 * The soft path, and the only removal offered here. Running instances pin the
 * version they started on and keep going; the definition simply stops being
 * something new runs can start from, and stops appearing in this list.
 * `deleteWorkflowDefinitionPermanently` exists and is deliberately not wired
 * up — it is irreversible, it refuses a definition that has ever run, and
 * neither of those is a thing to discover from a row menu.
 */
export async function archiveWorkflowDefinition(
  definitionId: string,
): Promise<WorkflowActionResult<WorkflowDefinitionSummary>> {
  return run(async () => {
    const data = await executeGraphqlRequest<{
      archiveWorkflowDefinition: WorkflowDefinitionSummary;
    }>({
      query: `mutation ArchiveWorkflowDefinition($definitionId: ID!) {
        archiveWorkflowDefinition(definitionId: $definitionId) { ${DEFINITION_FIELDS} }
      }`,
      variables: { definitionId },
    });
    return data.archiveWorkflowDefinition;
  });
}

/**
 * The graph to open, and the token a save has to present.
 *
 * The DRAFT is loaded, not the published version: `latestVersion` is what an
 * author was last working on, and opening the published one would silently
 * discard every unpublished edit the moment they saved. A definition with no
 * version yet opens on an empty graph, which is what a new definition is.
 */
export async function loadWorkflowDefinitionDraft(
  definitionId: string,
): Promise<
  WorkflowActionResult<{
    definition: WorkflowDefinitionSummary;
    version: WorkflowDefinitionVersionView | null;
  }>
> {
  return run(async () => {
    const summary = await executeGraphqlRequest<{
      workflowDefinition: WorkflowDefinitionSummary | null;
    }>({
      query: `query WorkflowDefinition($id: ID!) { workflowDefinition(id: $id) { ${DEFINITION_FIELDS} } }`,
      variables: { id: definitionId },
    });

    const definition = summary.workflowDefinition;
    if (!definition) throw new Error(`No workflow definition with id ${definitionId}.`);
    if (definition.latestVersion === null) return { definition, version: null };

    const version = await executeGraphqlRequest<{
      workflowDefinitionVersion: WorkflowDefinitionVersionView | null;
    }>({
      query: `query WorkflowDefinitionVersion($definitionId: ID!, $version: Int!) {
        workflowDefinitionVersion(definitionId: $definitionId, version: $version) {
          version definition publishedAt
        }
      }`,
      variables: { definitionId, version: definition.latestVersion },
    });

    return { definition, version: version.workflowDefinitionVersion };
  });
}

/**
 * Store a new draft version.
 *
 * `expectedUpdatedAt` is the definition's `updatedAt` as last read, and the
 * server refuses a stale one. The refreshed summary comes back so the caller
 * can hold the new token — a designer that kept the old one would fail every
 * subsequent save and look like it had lost the lock.
 *
 * Saving does not validate. A graph under construction has to be storable, and
 * the validation surface is a separate call for exactly that reason.
 */
export async function saveWorkflowDefinitionVersion(input: {
  definitionId: string;
  expectedUpdatedAt: string;
  definition: unknown;
  changelog?: string;
}): Promise<WorkflowActionResult<WorkflowDefinitionSummary>> {
  return run(async () => {
    const data = await executeGraphqlRequest<{
      saveWorkflowDefinitionVersion: WorkflowDefinitionSummary;
    }>({
      query: `mutation SaveWorkflowDefinitionVersion($input: SaveWorkflowDefinitionVersionInput!) {
        saveWorkflowDefinitionVersion(input: $input) { ${DEFINITION_FIELDS} }
      }`,
      variables: {
        input: {
          definitionId: input.definitionId,
          expectedUpdatedAt: input.expectedUpdatedAt,
          definition: input.definition,
          ...(input.changelog ? { changelog: input.changelog } : {}),
        },
      },
    });
    return data.saveWorkflowDefinitionVersion;
  });
}

/** Publish a stored version. Refuses any error-severity issue on the graph. */
export async function publishWorkflowDefinitionVersion(input: {
  definitionId: string;
  version: number;
}): Promise<WorkflowActionResult<{ version: number; publishedAt: string | null }>> {
  return run(async () => {
    const data = await executeGraphqlRequest<{
      publishWorkflowDefinitionVersion: { version: number; publishedAt: string | null };
    }>({
      query: `mutation PublishWorkflowDefinitionVersion($input: PublishWorkflowDefinitionVersionInput!) {
        publishWorkflowDefinitionVersion(input: $input) { version publishedAt }
      }`,
      variables: { input },
    });
    return data.publishWorkflowDefinitionVersion;
  });
}

/**
 * What is wrong with this graph, without writing it.
 *
 * A mutation on the wire despite reading nothing and changing nothing — it is
 * session-gated because the catalog it validates against is deployment
 * information. Called on the graph the canvas is holding, so the answer is
 * about what the author is looking at rather than about what was last stored.
 */
export async function validateWorkflowDefinition(
  definition: unknown,
): Promise<
  WorkflowActionResult<{ valid: boolean; issues: WorkflowValidationIssueView[] }>
> {
  return run(async () => {
    const data = await executeGraphqlRequest<{
      validateWorkflowDefinition: { valid: boolean; issues: WorkflowValidationIssueView[] };
    }>({
      query: `mutation ValidateWorkflowDefinition($definition: JSON!) {
        validateWorkflowDefinition(definition: $definition) { valid issues { ${ISSUE_FIELDS} } }
      }`,
      variables: { definition },
    });
    return data.validateWorkflowDefinition;
  });
}

/** Who holds the editing lock, if anyone. Null is "nobody", not an error. */
export async function readWorkflowDefinitionLock(
  definitionId: string,
): Promise<WorkflowActionResult<WorkflowDefinitionLockView | null>> {
  return run(async () => {
    const data = await executeGraphqlRequest<{
      workflowDefinitionLock: WorkflowDefinitionLockView | null;
    }>({
      query: `query WorkflowDefinitionLock($definitionId: ID!) {
        workflowDefinitionLock(definitionId: $definitionId) { ${LOCK_FIELDS} }
      }`,
      variables: { definitionId },
    });
    return data.workflowDefinitionLock;
  });
}

export async function acquireWorkflowDefinitionLock(
  definitionId: string,
): Promise<WorkflowActionResult<WorkflowDefinitionLockView>> {
  return run(async () => {
    const data = await executeGraphqlRequest<{
      acquireWorkflowDefinitionLock: WorkflowDefinitionLockView;
    }>({
      query: `mutation AcquireWorkflowDefinitionLock($definitionId: ID!) {
        acquireWorkflowDefinitionLock(definitionId: $definitionId) { ${LOCK_FIELDS} }
      }`,
      variables: { definitionId },
    });
    return data.acquireWorkflowDefinitionLock;
  });
}

/**
 * Take the lock from whoever holds it.
 *
 * Separate from acquiring on purpose, and not something to fall back to
 * automatically: the previous holder's token stops working, and their unsaved
 * work is theirs alone. A designer offers this behind a confirmation naming
 * who is being displaced.
 */
export async function stealWorkflowDefinitionLock(
  definitionId: string,
): Promise<WorkflowActionResult<WorkflowDefinitionLockView>> {
  return run(async () => {
    const data = await executeGraphqlRequest<{
      stealWorkflowDefinitionLock: WorkflowDefinitionLockView;
    }>({
      query: `mutation StealWorkflowDefinitionLock($definitionId: ID!) {
        stealWorkflowDefinitionLock(definitionId: $definitionId) { ${LOCK_FIELDS} }
      }`,
      variables: { definitionId },
    });
    return data.stealWorkflowDefinitionLock;
  });
}

export async function releaseWorkflowDefinitionLock(input: {
  definitionId: string;
  lockToken: string;
}): Promise<WorkflowActionResult<boolean>> {
  return run(async () => {
    const data = await executeGraphqlRequest<{ releaseWorkflowDefinitionLock: boolean }>({
      query: `mutation ReleaseWorkflowDefinitionLock($definitionId: ID!, $lockToken: String!) {
        releaseWorkflowDefinitionLock(definitionId: $definitionId, lockToken: $lockToken)
      }`,
      variables: input,
    });
    return data.releaseWorkflowDefinitionLock;
  });
}

/**
 * The message an author has to read, extracted before the boundary redacts it.
 *
 * `GraphqlProxyError` carries the API's own wording, which for this surface is
 * the whole content of the failure — "definition was modified by someone else",
 * "lock is held by ...". Falling back to the raw message keeps a transport
 * failure legible too.
 */
async function run<TValue>(
  operation: () => Promise<TValue>,
): Promise<WorkflowActionResult<TValue>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    if (isGraphqlProxyError(error)) {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
