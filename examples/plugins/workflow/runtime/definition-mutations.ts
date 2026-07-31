// SPDX-License-Identifier: BUSL-1.1
/**
 * The write path for workflow definitions.
 *
 * `workflow.definitions` and `workflow.definition_versions` are declared
 * `generatedCrud: false`, and this module is the reason. The generic entity
 * engine writes columns; a definition is not a row you write but an identity
 * whose graph accumulates immutable versions, and several invariants have to
 * hold across the pair of tables at once — none of which a per-column mutation
 * can express:
 *
 * **Versioning.** A save never mutates a stored graph. It appends
 * `max(version) + 1`, computed inside the same transaction as the insert and
 * behind the definition row's own `for update` lock, so two concurrent saves
 * queue rather than race. The unique index on
 * `(tenant_id, definition_id, version)` is the backstop, not the mechanism, and
 * a violation is translated into `CONFLICT` instead of escaping as a Postgres
 * error a caller would end up string-matching on.
 *
 * **Validation on publish, not on save.** A draft is allowed to be broken —
 * half-wired, mid-thought, saved because the author is going home. A published
 * version is what new runs start from, so it is refused unless the graph
 * validates clean. Gating earlier makes the designer unusable; gating later
 * turns a dangling edge into a failure discovered mid-run.
 *
 * **The edit gate.** Every write asserts view *and* edit (or view *and* delete)
 * through `definition-authorization.ts`. Authoring a workflow is authoring
 * executable behaviour for a whole tenant, which is why no role check is
 * written here — that decision has one home and this module calls it.
 * Long-running editor sessions are additionally serialized by the pessimistic
 * lock in `workflow.definition_locks`, which is a separate concern from these
 * short write transactions and is not acquired here.
 *
 * **A definition with runs is not deletable.** `workflow.instances` references
 * it `on delete restrict`, so the database would refuse anyway; checking first
 * turns a foreign-key violation into `CONFLICT` and a sentence that names the
 * alternative. Archiving is the soft path and is always available.
 *
 * Optimistic concurrency is the caller's half of the versioning invariant: a
 * save carries the `updatedAt` it read, and a definition that moved underneath
 * it is `CONCURRENT_MODIFICATION` rather than a silently forked draft.
 */
import type { OpenShapeForgeDatabase } from "../../../../apps/api/src/db/connection.js";
import {
  withDbSession,
  type DbSessionContext,
  type DbSessionInput,
} from "../../../../apps/api/src/db/session.js";
import {
  normalizeTimestampToken,
  timestampToIso,
} from "../../../../apps/api/src/db/timestamps.js";
import type { Json } from "../../../../apps/api/src/generated/db/types.js";
// `normalizeJsonValue` is a generic parsed-JSON helper that happens to live
// beside the event append; importing it back is cheaper than a third copy.
import {
  appendScopedEntityEventInTransaction,
  normalizeJsonValue,
} from "../../../../apps/api/src/platform/entity-events.js";
import {
  canDeleteDefinition,
  canEditDefinition,
  canViewDefinition,
  normalizeDefinitionAuthorization,
} from "./definition-authorization.js";
import { validateWorkflowDefinition } from "./definition-validation.js";
import {
  isWorkflowDefinitionCategory,
  normalizeDefinitionGraph,
  WorkflowDefinitionError,
  WORKFLOW_DEFINITION_CATEGORIES,
  type WorkflowDefinitionCategory,
  type WorkflowDefinitionGraph,
  type WorkflowDefinitionRecord,
  type WorkflowDefinitionVersionRecord,
} from "./definition-types.js";
// Row-to-record mapping belongs to the read path and is borrowed, not repeated:
// a write that returned a differently-shaped record than a subsequent read is
// the drift these two modules exist to avoid.
import {
  isUuid,
  mapWorkflowDefinitionRecord,
  mapWorkflowDefinitionVersionRecord,
} from "./definitions.js";

export type CreateWorkflowDefinitionInput = {
  name: string;
  description?: string | null;
  category?: string | null;
  authorization?: Json | null;
};

export type UpdateWorkflowDefinitionInput = {
  definitionId: string;
  name?: string | null;
  description?: string | null;
  category?: string | null;
  authorization?: Json | null;
};

export type SaveWorkflowDefinitionVersionInput = {
  definitionId: string;
  /** The `updatedAt` the caller last read; see the note on concurrency above. */
  expectedUpdatedAt: string;
  definition: Json;
  changelog?: string | null;
};

export type PublishWorkflowDefinitionVersionInput = {
  definitionId: string;
  version: number;
};

const DEFINITION_AGGREGATE = "workflow.definition";

/** The index the version insert can collide on, named for the error translation. */
const VERSION_UNIQUE_INDEX = "workflow_definition_versions_unique_idx";

/**
 * Kysely's `Transaction<DB>`, derived rather than imported.
 *
 * This directory sits in the `examples/` workspace, which depends on nothing
 * that `apps/api` depends on — kysely resolves from there, not from here — so
 * the transaction type is read off the database handle that is already
 * imported. It is the same type `withDbSession` hands its callback.
 */
type DefinitionTransaction = Parameters<
  Parameters<ReturnType<OpenShapeForgeDatabase["transaction"]>["execute"]>[0]
>[0];

/**
 * A definition graph and an ACL are both parsed JSON documents, but their
 * TypeScript shapes carry `unknown`-typed leaves (`node.config`) that `Json`
 * cannot express. The assertion restates what the parse already established
 * rather than widening anything.
 */
function toJson(value: unknown): Json {
  return value as Json;
}

/**
 * The read path treats a malformed id as a miss; a write cannot. "You asked for
 * something that is not an id" and "there is no such definition" are different
 * answers, and only one of them is worth retrying.
 */
function requireUuid(value: string, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!isUuid(normalized)) {
    throw new WorkflowDefinitionError("BAD_USER_INPUT", `${label} must be a UUID.`);
  }
  return normalized;
}

function requireText(value: string | null | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new WorkflowDefinitionError("BAD_USER_INPUT", `${label} is required.`);
  }
  return normalized;
}

function optionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function requireCategory(value: string | null | undefined): WorkflowDefinitionCategory {
  const normalized = value?.trim();
  if (!normalized || !isWorkflowDefinitionCategory(normalized)) {
    throw new WorkflowDefinitionError(
      "BAD_USER_INPUT",
      `category must be one of: ${WORKFLOW_DEFINITION_CATEGORIES.join(", ")}.`,
    );
  }
  return normalized;
}

/**
 * The stored ACL is always canonical `{ view, edit, delete }` with string
 * arrays, because the column is jsonb and nothing else would stop a caller
 * putting an arbitrary document where an authorization decision reads.
 */
function normalizeIncomingAuthorization(value: Json | null | undefined) {
  return normalizeDefinitionAuthorization(
    value === undefined || value === null ? {} : normalizeJsonValue(value),
  );
}

/**
 * A draft may be broken — dangling edges, unknown node types, no trigger at all
 * — and still has to be saveable, so nothing on this path calls the validator.
 * What is enforced is the one shape the storage layer promises its readers: an
 * object with array `nodes` and `edges`. Everything else in the document is
 * carried through untouched; a non-array `nodes` or `edges` is replaced with an
 * empty one, because a row the read path cannot normalize is a row nobody can
 * open in the designer to fix.
 */
function normalizeIncomingGraph(value: Json): WorkflowDefinitionGraph {
  const parsed = normalizeJsonValue(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkflowDefinitionError(
      "BAD_USER_INPUT",
      "definition must be a JSON object holding nodes and edges.",
    );
  }
  return normalizeDefinitionGraph(parsed);
}

function requireTimestampToken(value: string, label: string): string {
  try {
    return normalizeTimestampToken(value);
  } catch {
    throw new WorkflowDefinitionError(
      "BAD_USER_INPUT",
      `${label} must be an ISO timestamp.`,
    );
  }
}

/**
 * Every write stamps `updated_at` with a millisecond-precision value.
 *
 * The column is the optimistic-concurrency token, so what matters is that every
 * read path renders the stored value to the same string. Postgres `now()` has
 * microsecond precision, which a driver that hands back a JS `Date` silently
 * truncates while a driver that hands back text does not — two readers, two
 * tokens, and saves that fail for no reason the caller can see. A value JS can
 * represent exactly removes the disagreement at the source.
 */
function concurrencyStamp(): Date {
  return new Date();
}

/**
 * A collision on the version unique index, recognized without assuming a driver.
 *
 * The SQLSTATE is the real signal, but which property carries it is the
 * driver's business and not a contract this module can rely on, so the
 * constraint name is accepted as evidence too.
 */
function isVersionCollision(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    errno?: unknown;
    constraint?: unknown;
    message?: unknown;
  };
  if (candidate.code === "23505" || candidate.errno === "23505") return true;
  if (candidate.constraint === VERSION_UNIQUE_INDEX) return true;
  return (
    typeof candidate.message === "string" &&
    candidate.message.includes(VERSION_UNIQUE_INDEX)
  );
}

/**
 * Take the definition row's write lock, which is what makes `max(version) + 1`
 * safe: concurrent saves against one definition serialize here rather than at
 * the unique index.
 */
async function lockDefinition(
  trx: DefinitionTransaction,
  tenantId: string,
  definitionId: string,
  options: { includeArchived?: boolean } = {},
) {
  let query = trx
    .selectFrom("workflow.definitions")
    .select(["id", "authorization", "is_active", "updated_at"])
    .where("tenant_id", "=", tenantId)
    .where("id", "=", definitionId);

  if (!options.includeArchived) {
    query = query.where("is_active", "=", true);
  }

  const row = await query.forUpdate().executeTakeFirst();
  if (!row) {
    throw new WorkflowDefinitionError(
      "NOT_FOUND",
      `Workflow definition ${definitionId} was not found.`,
    );
  }
  return row;
}

async function loadDefinitionRecord(
  trx: DefinitionTransaction,
  tenantId: string,
  definitionId: string,
): Promise<WorkflowDefinitionRecord> {
  const row = await trx
    .selectFrom("workflow.definitions")
    .select([
      "id",
      "name",
      "description",
      "category",
      "parent_definition_id",
      "parent_node_id",
      "external_id",
      "is_active",
      "created_at",
      "updated_at",
    ])
    .where("tenant_id", "=", tenantId)
    .where("id", "=", definitionId)
    .executeTakeFirst();

  if (!row) {
    throw new WorkflowDefinitionError(
      "NOT_FOUND",
      `Workflow definition ${definitionId} was not found.`,
    );
  }

  // The read path derives these three with correlated subqueries; here they come
  // out of one ordered scan of a definition's own versions, which is the same
  // answer for a single definition and keeps this module off raw SQL.
  const versions = await trx
    .selectFrom("workflow.definition_versions")
    .select(["version", "published_at", "definition"])
    .where("tenant_id", "=", tenantId)
    .where("definition_id", "=", definitionId)
    .orderBy("version", "desc")
    .execute();

  const published = versions.find((version) => version.published_at !== null);
  return mapWorkflowDefinitionRecord({
    ...row,
    published_version: published?.version ?? null,
    latest_version: versions[0]?.version ?? null,
    published_definition: published?.definition ?? null,
  });
}

/**
 * View is asserted alongside edit even though `canEditDefinition` already
 * requires it. The pair is the rule this module is holding to, and stating it
 * at the call site is what keeps it true if the composition inside the
 * authorization module ever changes.
 */
function assertVisibleAndEditable(
  authorization: unknown,
  session: DbSessionContext,
  action: string,
): void {
  const acl = normalizeDefinitionAuthorization(authorization);
  if (!canViewDefinition(acl, session) || !canEditDefinition(acl, session)) {
    throw new WorkflowDefinitionError("FORBIDDEN", `Not authorized to ${action}.`);
  }
}

function assertVisibleAndDeletable(
  authorization: unknown,
  session: DbSessionContext,
  action: string,
): void {
  const acl = normalizeDefinitionAuthorization(authorization);
  if (!canViewDefinition(acl, session) || !canDeleteDefinition(acl, session)) {
    throw new WorkflowDefinitionError("FORBIDDEN", `Not authorized to ${action}.`);
  }
}

function assertPublishable(version: number, definition: Json): void {
  const errors = validateWorkflowDefinition(definition).issues.filter(
    (issue) => issue.severity === "error",
  );
  if (errors.length === 0) return;

  const detail = errors.map((issue) => `${issue.path}: ${issue.message}`).join(" ");
  throw new WorkflowDefinitionError(
    "BAD_USER_INPUT",
    `Version ${version} cannot be published; its graph has ${errors.length} validation ` +
      `${errors.length === 1 ? "error" : "errors"}. ${detail}`,
  );
}

type DraftVersionInsert = {
  tenantId: string;
  definitionId: string;
  version: number;
  definition: Json;
  changelog: string | null;
};

async function insertDraftVersion(
  trx: DefinitionTransaction,
  input: DraftVersionInsert,
): Promise<{ id: string }> {
  try {
    return await trx
      .insertInto("workflow.definition_versions")
      .values({
        tenant_id: input.tenantId,
        definition_id: input.definitionId,
        version: input.version,
        definition: input.definition,
        published_at: null,
        published_by: null,
        changelog: input.changelog,
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
  } catch (error) {
    if (!isVersionCollision(error)) throw error;
    throw new WorkflowDefinitionError(
      "CONFLICT",
      `Version ${input.version} of workflow definition ${input.definitionId} already exists; re-read the definition and save again.`,
    );
  }
}

export async function createWorkflowDefinition(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: CreateWorkflowDefinitionInput,
): Promise<WorkflowDefinitionRecord> {
  const name = requireText(input.name, "name");
  const description = optionalText(input.description);
  const category = requireCategory(input.category ?? "process");
  const authorization = normalizeIncomingAuthorization(input.authorization);

  return withDbSession(db, session, async (trx, scopedSession) => {
    // No row exists yet, so the ACL under test is the one this call is about to
    // store. That also refuses a definition whose author could not then open it
    // — a lockout with no path back through the API — and routes the create
    // through the same writer-role check every other write goes through.
    assertVisibleAndEditable(authorization, scopedSession, "create workflow definitions");

    const created = await trx
      .insertInto("workflow.definitions")
      .values({
        tenant_id: scopedSession.tenantId,
        name,
        description,
        category,
        authorization: toJson(authorization),
        updated_at: concurrencyStamp(),
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();

    await appendScopedEntityEventInTransaction(trx, {
      aggregateType: DEFINITION_AGGREGATE,
      aggregateId: created.id,
      eventType: "workflow.definition.created",
      payload: { definitionId: created.id, name, category },
    });

    return loadDefinitionRecord(trx, scopedSession.tenantId, created.id);
  });
}

/**
 * Metadata only. The graph is never reachable from here — changing what a
 * workflow does is a version, and versions are what
 * `saveWorkflowDefinitionVersion` appends.
 */
export async function updateWorkflowDefinition(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: UpdateWorkflowDefinitionInput,
): Promise<WorkflowDefinitionRecord> {
  const definitionId = requireUuid(input.definitionId, "definitionId");
  const name = input.name === undefined ? undefined : requireText(input.name, "name");
  const description =
    input.description === undefined ? undefined : optionalText(input.description);
  const category =
    input.category === undefined ? undefined : requireCategory(input.category);
  const authorization =
    input.authorization === undefined
      ? undefined
      : normalizeIncomingAuthorization(input.authorization);

  // An update with nothing in it would still bump `updated_at` and invalidate
  // every outstanding save token, which is a surprising cost for a no-op.
  if (
    name === undefined &&
    description === undefined &&
    category === undefined &&
    authorization === undefined
  ) {
    throw new WorkflowDefinitionError(
      "BAD_USER_INPUT",
      "At least one of name, description, category or authorization must be provided.",
    );
  }

  return withDbSession(db, session, async (trx, scopedSession) => {
    const definition = await lockDefinition(trx, scopedSession.tenantId, definitionId);
    // The stored ACL decides, not the incoming one: handing a definition over to
    // another owner is a legitimate edit, and testing the new ACL would make
    // every hand-off impossible.
    assertVisibleAndEditable(
      definition.authorization,
      scopedSession,
      "edit this workflow definition",
    );

    await trx
      .updateTable("workflow.definitions")
      .set({
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(category !== undefined ? { category } : {}),
        ...(authorization !== undefined
          ? { authorization: toJson(authorization) }
          : {}),
        updated_at: concurrencyStamp(),
      })
      .where("tenant_id", "=", scopedSession.tenantId)
      .where("id", "=", definitionId)
      .execute();

    await appendScopedEntityEventInTransaction(trx, {
      aggregateType: DEFINITION_AGGREGATE,
      aggregateId: definitionId,
      eventType: "workflow.definition.updated",
      payload: {
        definitionId,
        fields: [
          ...(name !== undefined ? ["name"] : []),
          ...(description !== undefined ? ["description"] : []),
          ...(category !== undefined ? ["category"] : []),
          ...(authorization !== undefined ? ["authorization"] : []),
        ],
      },
    });

    return loadDefinitionRecord(trx, scopedSession.tenantId, definitionId);
  });
}

/**
 * Append a new draft version. Returns the definition record, whose `updatedAt`
 * is the token the next save has to carry.
 */
export async function saveWorkflowDefinitionVersion(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: SaveWorkflowDefinitionVersionInput,
): Promise<WorkflowDefinitionRecord> {
  const definitionId = requireUuid(input.definitionId, "definitionId");
  const expectedUpdatedAt = requireTimestampToken(
    input.expectedUpdatedAt,
    "expectedUpdatedAt",
  );
  const graph = normalizeIncomingGraph(input.definition);
  const changelog = optionalText(input.changelog);

  return withDbSession(db, session, async (trx, scopedSession) => {
    const definition = await lockDefinition(trx, scopedSession.tenantId, definitionId);
    assertVisibleAndEditable(
      definition.authorization,
      scopedSession,
      "save a version of this workflow definition",
    );

    // Both sides go through the same renderer: the token crossed a wire as a
    // string and a Postgres timestamp is not one string but several.
    if (timestampToIso(definition.updated_at) !== expectedUpdatedAt) {
      throw new WorkflowDefinitionError(
        "CONCURRENT_MODIFICATION",
        "This workflow definition was modified by another request; re-read it and save again.",
      );
    }

    const latest = await trx
      .selectFrom("workflow.definition_versions")
      .select("version")
      .where("tenant_id", "=", scopedSession.tenantId)
      .where("definition_id", "=", definitionId)
      .orderBy("version", "desc")
      .limit(1)
      .executeTakeFirst();

    const nextVersion = (latest?.version ?? 0) + 1;
    const saved = await insertDraftVersion(trx, {
      tenantId: scopedSession.tenantId,
      definitionId,
      version: nextVersion,
      definition: toJson(graph),
      changelog,
    });

    await trx
      .updateTable("workflow.definitions")
      .set({ updated_at: concurrencyStamp() })
      .where("tenant_id", "=", scopedSession.tenantId)
      .where("id", "=", definitionId)
      .execute();

    await appendScopedEntityEventInTransaction(trx, {
      aggregateType: DEFINITION_AGGREGATE,
      aggregateId: definitionId,
      eventType: "workflow.definition.version_saved",
      payload: { definitionId, versionId: saved.id, version: nextVersion },
    });

    return loadDefinitionRecord(trx, scopedSession.tenantId, definitionId);
  });
}

export async function publishWorkflowDefinitionVersion(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: PublishWorkflowDefinitionVersionInput,
): Promise<WorkflowDefinitionVersionRecord> {
  const definitionId = requireUuid(input.definitionId, "definitionId");
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new WorkflowDefinitionError(
      "BAD_USER_INPUT",
      "version must be a positive integer.",
    );
  }

  return withDbSession(db, session, async (trx, scopedSession) => {
    const definition = await lockDefinition(trx, scopedSession.tenantId, definitionId);
    assertVisibleAndEditable(
      definition.authorization,
      scopedSession,
      "publish this workflow definition",
    );

    const version = await trx
      .selectFrom("workflow.definition_versions")
      .selectAll()
      .where("tenant_id", "=", scopedSession.tenantId)
      .where("definition_id", "=", definitionId)
      .where("version", "=", input.version)
      .executeTakeFirst();

    if (!version) {
      throw new WorkflowDefinitionError(
        "NOT_FOUND",
        `Version ${input.version} of workflow definition ${definitionId} was not found.`,
      );
    }

    // Idempotent, and deliberately without re-validating: this version is
    // already what runs start from, so refusing now would strand it rather than
    // protect anything.
    if (version.published_at !== null) {
      return mapWorkflowDefinitionVersionRecord(version);
    }

    assertPublishable(input.version, version.definition);

    const publishedAt = concurrencyStamp();
    const published = await trx
      .updateTable("workflow.definition_versions")
      .set({ published_at: publishedAt, published_by: scopedSession.userId })
      .where("tenant_id", "=", scopedSession.tenantId)
      .where("definition_id", "=", definitionId)
      .where("version", "=", input.version)
      .returningAll()
      .executeTakeFirstOrThrow();

    await trx
      .updateTable("workflow.definitions")
      .set({ updated_at: publishedAt })
      .where("tenant_id", "=", scopedSession.tenantId)
      .where("id", "=", definitionId)
      .execute();

    await appendScopedEntityEventInTransaction(trx, {
      aggregateType: DEFINITION_AGGREGATE,
      aggregateId: definitionId,
      eventType: "workflow.definition.published",
      payload: {
        definitionId,
        versionId: published.id,
        version: published.version,
      },
    });

    // Publishing records intent and nothing more. A graph whose trigger is a
    // clock becomes eligible to run here, but this deployment has no scheduler,
    // so nothing arms a schedule and nothing fires. The seam is left open on
    // purpose: when a scheduler lands it reads the published version off this
    // table, and this is the point that has to tell it.
    return mapWorkflowDefinitionVersionRecord(published);
  });
}

/**
 * The soft path: `is_active = false`. Existing instances pin the version they
 * started on and keep running; the definition simply stops being something new
 * runs can be started from.
 */
export async function archiveWorkflowDefinition(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  definitionId: string,
): Promise<WorkflowDefinitionRecord> {
  const id = requireUuid(definitionId, "definitionId");

  return withDbSession(db, session, async (trx, scopedSession) => {
    const definition = await lockDefinition(trx, scopedSession.tenantId, id);
    assertVisibleAndDeletable(
      definition.authorization,
      scopedSession,
      "archive this workflow definition",
    );

    await trx
      .updateTable("workflow.definitions")
      .set({ is_active: false, updated_at: concurrencyStamp() })
      .where("tenant_id", "=", scopedSession.tenantId)
      .where("id", "=", id)
      .execute();

    await appendScopedEntityEventInTransaction(trx, {
      aggregateType: DEFINITION_AGGREGATE,
      aggregateId: id,
      eventType: "workflow.definition.archived",
      payload: { definitionId: id },
    });

    return loadDefinitionRecord(trx, scopedSession.tenantId, id);
  });
}

/**
 * The hard path, and the only one that refuses. Versions and editor locks
 * cascade; instances do not, and a definition that has ever been run is history
 * somebody may still need to read.
 */
export async function deleteWorkflowDefinitionPermanently(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  definitionId: string,
): Promise<void> {
  const id = requireUuid(definitionId, "definitionId");

  return withDbSession(db, session, async (trx, scopedSession) => {
    // Archived definitions are deletable: archiving is the reversible step, and
    // purging one afterwards is the whole reason for having both.
    const definition = await lockDefinition(trx, scopedSession.tenantId, id, {
      includeArchived: true,
    });
    assertVisibleAndDeletable(
      definition.authorization,
      scopedSession,
      "delete this workflow definition",
    );

    const instance = await trx
      .selectFrom("workflow.instances")
      .select("id")
      .where("tenant_id", "=", scopedSession.tenantId)
      .where("definition_id", "=", id)
      .limit(1)
      .executeTakeFirst();

    if (instance) {
      throw new WorkflowDefinitionError(
        "CONFLICT",
        "A workflow definition that has instances cannot be permanently deleted; archive it instead.",
      );
    }

    // Appended before the delete, so the event is written while the aggregate it
    // names still exists. Once the row is gone this event is the only remaining
    // record that it ever did.
    await appendScopedEntityEventInTransaction(trx, {
      aggregateType: DEFINITION_AGGREGATE,
      aggregateId: id,
      eventType: "workflow.definition.deleted",
      payload: { definitionId: id },
    });

    await trx
      .deleteFrom("workflow.definitions")
      .where("tenant_id", "=", scopedSession.tenantId)
      .where("id", "=", id)
      .execute();
  });
}
