// SPDX-License-Identifier: BUSL-1.1
/**
 * The read half of the workflow definition surface.
 *
 * Every read answers the same two questions — which definitions may this
 * session see, and what does a designer need to know about each one — so the
 * gates that decide the first are applied in one place instead of once per
 * resolver. Keeping the reads apart from the writes is what stops that stack
 * from being restated, and eventually contradicted, in the module that saves,
 * publishes and archives. Both halves hand back the record types declared in
 * `definition-types.ts`, so the row mappers here are exported rather than
 * private: a write that returned a record assembled its own way would be a
 * second, quietly different answer to the same question.
 *
 * ## What a record is assembled from
 *
 * A `WorkflowDefinitionRecord` is one `workflow.definitions` row plus three
 * facts that live in `workflow.definition_versions`: which version is
 * published, which is the latest, and which trigger types the published graph
 * contains. They belong on the record because a definition list is filtered and
 * grouped by exactly those, and a caller that had to fetch versions per row
 * would issue a query per definition to render one list.
 *
 * The published graph is therefore read in full to derive its trigger types.
 * `isTriggerNodeType` in `definition-types.ts` decides what counts as a
 * trigger, and expressing that predicate a second time in SQL would give the
 * two copies somewhere to disagree — a definition would then list a trigger the
 * runtime does not recognise, or hide one it does.
 *
 * ## Archiving is a soft delete
 *
 * `is_active` is how a definition is removed, and every read here filters on
 * it: to a reader an archived definition does not exist. `isActive` still rides
 * on the record because the write path returns the same type after archiving
 * one, and the caller that just archived it needs to see that it worked.
 */
import type { OpenShapeForgeDatabase } from "../../../../apps/api/src/db/connection.js";
import {
  withDbSession,
  type DbSessionContext,
  type DbSessionInput,
} from "../../../../apps/api/src/db/session.js";
import { timestampToIso } from "../../../../apps/api/src/db/timestamps.js";
import type { DB, Json } from "../../../../apps/api/src/generated/db/types.js";
import { normalizeJsonValue } from "../../../../apps/api/src/platform/entity-events.js";
import {
  canViewDefinition,
  normalizeDefinitionAuthorization,
} from "./definition-authorization.js";
import {
  WorkflowDefinitionError,
  extractTriggerTypes,
  isWorkflowDefinitionCategory,
  normalizeDefinitionGraph,
  type WorkflowDefinitionCategory,
  type WorkflowDefinitionRecord,
  type WorkflowDefinitionVersionRecord,
} from "./definition-types.js";

/**
 * The transaction `withDbSession` hands its callback, derived instead of
 * imported. `kysely` is a dependency of `apps/api`, which the plugin runtime
 * reaches into by path rather than by package name, so its types are taken from
 * the signatures that already cross that boundary. Every query below is built
 * through those, which is also why nothing here writes raw SQL.
 */
type DbTransaction = Parameters<Parameters<typeof withDbSession<DB, unknown>>[2]>[0];

export type WorkflowDefinitionFilter = {
  category?: string | null;
  categories?: readonly (string | null | undefined)[] | null;
  /** Case-insensitive substring of the name or of the description. */
  search?: string | null;
};

/** A version without its graph, for listings that only need the history. */
export type WorkflowDefinitionVersionSummary = Omit<
  WorkflowDefinitionVersionRecord,
  "definition"
>;

/**
 * What the record mapper reads, rather than `Selectable<WorkflowDefinitionsTable>`.
 *
 * The version-derived columns are optional because the write path maps rows
 * that have no versions yet — a definition one statement old has neither a
 * published nor a latest version, and requiring it to invent those columns
 * would push this module's query shape into the module that inserts. Timestamps
 * accept the driver's `Date` as well as text so a `returning` clause maps
 * without a cast.
 */
export type WorkflowDefinitionRow = {
  id: string;
  name: string;
  description: string | null;
  category: string;
  parent_definition_id: string | null;
  parent_node_id: string | null;
  external_id: string | null;
  is_active: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  published_version?: number | null;
  latest_version?: number | null;
  published_definition?: Json | null;
};

export type WorkflowDefinitionVersionSummaryRow = {
  id: string;
  definition_id: string;
  version: number;
  published_at: Date | string | null;
  published_by: string | null;
  changelog: string | null;
  created_at: Date | string;
};

export type WorkflowDefinitionVersionRow = WorkflowDefinitionVersionSummaryRow & {
  definition: Json;
};

/**
 * A malformed id is a miss, not a failure: Postgres raises on a value that is
 * not a uuid literal, which would surface as a server error for what is really
 * "no such definition".
 */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/**
 * Nothing constrains `category` in the database beyond its default, so a row
 * can hold a value this build does not know. It reads as `process` rather than
 * being dropped, for the reason `normalizeDefinitionGraph` gives: a row nobody
 * can read is a row nobody can fix.
 */
function toCategory(value: string): WorkflowDefinitionCategory {
  return isWorkflowDefinitionCategory(value) ? value : "process";
}

/**
 * The per-definition ACL, evaluated against the stored jsonb.
 *
 * The column is parsed before it is narrowed. `normalizeDefinitionAuthorization`
 * treats anything it cannot read as an empty subject set, and an empty set
 * means visible — so an ACL that reached this process as encoded text would
 * silently publish a restricted definition to the whole tenant.
 */
function canViewDefinitionRow(authorization: Json, session: DbSessionContext): boolean {
  return canViewDefinition(
    normalizeDefinitionAuthorization(normalizeJsonValue(authorization)),
    session,
  );
}

export function mapWorkflowDefinitionRecord(
  row: WorkflowDefinitionRow,
): WorkflowDefinitionRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: toCategory(row.category),
    parentDefinitionId: row.parent_definition_id,
    parentNodeId: row.parent_node_id,
    externalId: row.external_id,
    isActive: row.is_active,
    createdAt: timestampToIso(row.created_at),
    updatedAt: timestampToIso(row.updated_at),
    // The stored graph is narrowed, never re-parsed: jsonb arrives already
    // parsed from the driver, and walking it to parse strings a second time
    // would rewrite author-supplied config values — an account number "0123"
    // would come back as the number 123.
    triggerTypes: extractTriggerTypes(
      normalizeDefinitionGraph(row.published_definition ?? null),
    ),
    publishedVersion: row.published_version ?? null,
    latestVersion: row.latest_version ?? null,
  };
}

export function mapWorkflowDefinitionVersionSummary(
  row: WorkflowDefinitionVersionSummaryRow,
): WorkflowDefinitionVersionSummary {
  return {
    id: row.id,
    definitionId: row.definition_id,
    version: row.version,
    publishedAt: row.published_at ? timestampToIso(row.published_at) : null,
    publishedBy: row.published_by,
    changelog: row.changelog,
    createdAt: timestampToIso(row.created_at),
  };
}

export function mapWorkflowDefinitionVersionRecord(
  row: WorkflowDefinitionVersionRow,
): WorkflowDefinitionVersionRecord {
  return {
    ...mapWorkflowDefinitionVersionSummary(row),
    definition: normalizeDefinitionGraph(row.definition),
  };
}

/**
 * A requested category has to be one this build knows, or the filter would
 * silently return nothing and read as "there are none" instead of "you asked
 * for something that does not exist".
 */
function normalizeCategories(
  filter: WorkflowDefinitionFilter,
): WorkflowDefinitionCategory[] | null {
  const requested = [filter.category, ...(filter.categories ?? [])];
  const categories = new Set<WorkflowDefinitionCategory>();

  for (const entry of requested) {
    const value = typeof entry === "string" ? entry.trim() : "";
    if (!value) continue;
    if (!isWorkflowDefinitionCategory(value)) {
      throw new WorkflowDefinitionError(
        "BAD_USER_INPUT",
        `Unknown workflow definition category "${value}".`,
      );
    }
    categories.add(value);
  }

  return categories.size > 0 ? [...categories] : null;
}

function searchPattern(search: string | null | undefined): string | null {
  const trimmed = search?.trim();
  return trimmed ? `%${trimmed}%` : null;
}

/**
 * The shape every definition read selects.
 *
 * The tenant predicate is written out even though `workflow.definitions` is
 * `tenantScoped` and carries the generated RLS policy. The policy is the real
 * boundary — it holds when this predicate is forgotten — but the predicate
 * keeps the planner on the tenant-leading indexes and makes a query that ran
 * outside a session fail closed rather than read the table. Both, always.
 *
 * The two laterals resolve the published and the latest version through
 * `workflow_definition_versions_unique_idx`, so each is a one-row index lookup
 * per definition rather than a sort over its history.
 */
function selectDefinitions(trx: DbTransaction, tenantId: string) {
  return trx
    .selectFrom("workflow.definitions as d")
    .leftJoinLateral(
      (eb) =>
        eb
          .selectFrom("workflow.definition_versions as pv")
          .select(["pv.version", "pv.definition"])
          .where("pv.tenant_id", "=", tenantId)
          .whereRef("pv.definition_id", "=", "d.id")
          .where("pv.published_at", "is not", null)
          .orderBy("pv.version", "desc")
          .limit(1)
          .as("published"),
      (join) => join.onTrue(),
    )
    .leftJoinLateral(
      (eb) =>
        eb
          .selectFrom("workflow.definition_versions as lv")
          .select("lv.version")
          .where("lv.tenant_id", "=", tenantId)
          .whereRef("lv.definition_id", "=", "d.id")
          .orderBy("lv.version", "desc")
          .limit(1)
          .as("latest"),
      (join) => join.onTrue(),
    )
    .select((eb) => [
      "d.id",
      "d.name",
      "d.description",
      "d.category",
      "d.parent_definition_id",
      "d.parent_node_id",
      "d.external_id",
      "d.authorization",
      "d.is_active",
      // `updated_at` is the optimistic-concurrency token a save sends back, so
      // it is read as text: parsed into a `Date` it loses the stored
      // microseconds, and a token missing digits no longer matches the row it
      // guards. `created_at` is read the same way so both serialize alike.
      eb.cast<string>("d.created_at", "text").as("created_at"),
      eb.cast<string>("d.updated_at", "text").as("updated_at"),
      "published.version as published_version",
      "published.definition as published_definition",
      "latest.version as latest_version",
    ])
    .where("d.tenant_id", "=", tenantId)
    .where("d.is_active", "=", true);
}

/**
 * Definition reads, with the per-definition ACL applied in this process after
 * the rows come back.
 *
 * The cost is real and worth naming: the database returns every active
 * definition in the tenant that matches the filter, and the process discards
 * the ones this session may not see. That is correct, and affordable only
 * because a tenant holds tens of definitions rather than millions — it does not
 * scale, and it forecloses pagination outright. A LIMIT or OFFSET pushed into
 * this query would be applied BEFORE the ACL, so a page would come back short
 * and the following page would skip rows. Paginating means moving this
 * predicate into SQL first; it cannot be layered on top of what is here.
 *
 * The subjects compared are the scoped session's — the same session the
 * statement ran under. Its groups are the UUID-filtered set (`normalizeGroups`
 * in `apps/api/src/db/session.ts`), so a `groups` entry in a stored ACL has to
 * name an org-unit id; an identity-provider group path stored there matches
 * nobody.
 */
async function listDefinitions(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  filter: WorkflowDefinitionFilter,
  publishedOnly: boolean,
): Promise<WorkflowDefinitionRecord[]> {
  const categories = normalizeCategories(filter);
  const pattern = searchPattern(filter.search);

  return withDbSession(db, session, async (trx, scoped) => {
    let query = selectDefinitions(trx, scoped.tenantId)
      .orderBy("d.updated_at", "desc")
      .orderBy("d.name", "asc");

    if (categories) {
      query = query.where("d.category", "in", categories);
    }

    if (pattern) {
      query = query.where((eb) =>
        eb.or([eb("d.name", "ilike", pattern), eb("d.description", "ilike", pattern)]),
      );
    }

    if (publishedOnly) {
      // The lateral already found the published version, so requiring it is
      // what turns the outer join into the filter.
      query = query.where("published.version", "is not", null);
    }

    const rows = await query.execute();
    return rows
      .filter((row) => canViewDefinitionRow(row.authorization, scoped))
      .map(mapWorkflowDefinitionRecord);
  });
}

export async function listWorkflowDefinitions(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  filter: WorkflowDefinitionFilter = {},
): Promise<WorkflowDefinitionRecord[]> {
  return listDefinitions(db, session, filter, false);
}

/**
 * Only definitions with a published version — what a caller that wants to RUN
 * something asks for, as opposed to what a designer edits.
 */
export async function listPublishedWorkflowDefinitions(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  filter: WorkflowDefinitionFilter = {},
): Promise<WorkflowDefinitionRecord[]> {
  return listDefinitions(db, session, filter, true);
}

export async function getWorkflowDefinition(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  definitionId: string,
): Promise<WorkflowDefinitionRecord | null> {
  if (!isUuid(definitionId)) return null;

  return withDbSession(db, session, async (trx, scoped) => {
    const row = await selectDefinitions(trx, scoped.tenantId)
      .where("d.id", "=", definitionId)
      .executeTakeFirst();

    if (!row || !canViewDefinitionRow(row.authorization, scoped)) return null;
    return mapWorkflowDefinitionRecord(row);
  });
}

/**
 * A version is readable only through its definition: the ACL lives on the
 * definition row, and `workflow.definition_versions` carries none of its own.
 * Every version read therefore resolves the parent first, and an invisible
 * parent is reported as a miss rather than as a refusal — telling a caller that
 * a definition exists but is not theirs is itself a disclosure.
 */
async function isDefinitionVisible(
  trx: DbTransaction,
  session: DbSessionContext,
  definitionId: string,
): Promise<boolean> {
  const row = await trx
    .selectFrom("workflow.definitions")
    .select("authorization")
    .where("tenant_id", "=", session.tenantId)
    .where("id", "=", definitionId)
    .where("is_active", "=", true)
    .executeTakeFirst();

  return row ? canViewDefinitionRow(row.authorization, session) : false;
}

function selectVersionSummaries(
  trx: DbTransaction,
  tenantId: string,
  definitionId: string,
) {
  return trx
    .selectFrom("workflow.definition_versions")
    .select((eb) => [
      "id",
      "definition_id",
      "version",
      eb.cast<string | null>("published_at", "text").as("published_at"),
      "published_by",
      "changelog",
      eb.cast<string>("created_at", "text").as("created_at"),
    ])
    .where("tenant_id", "=", tenantId)
    .where("definition_id", "=", definitionId);
}

/** The summary plus the graph, for the reads that hand back a whole version. */
function selectVersions(trx: DbTransaction, tenantId: string, definitionId: string) {
  return selectVersionSummaries(trx, tenantId, definitionId).select("definition");
}

export async function getWorkflowDefinitionVersion(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  definitionId: string,
  version: number,
): Promise<WorkflowDefinitionVersionRecord | null> {
  if (!isUuid(definitionId) || !Number.isInteger(version)) return null;

  return withDbSession(db, session, async (trx, scoped) => {
    if (!(await isDefinitionVisible(trx, scoped, definitionId))) return null;

    const row = await selectVersions(trx, scoped.tenantId, definitionId)
      .where("version", "=", version)
      .executeTakeFirst();

    return row ? mapWorkflowDefinitionVersionRecord(row) : null;
  });
}

/**
 * The version a run should start on. Highest published version wins, which is
 * not necessarily the highest version: a draft saved after a publish sits above
 * it and must not be executed.
 */
export async function getLatestPublishedWorkflowDefinitionVersion(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  definitionId: string,
): Promise<WorkflowDefinitionVersionRecord | null> {
  if (!isUuid(definitionId)) return null;

  return withDbSession(db, session, async (trx, scoped) => {
    if (!(await isDefinitionVisible(trx, scoped, definitionId))) return null;

    const row = await selectVersions(trx, scoped.tenantId, definitionId)
      .where("published_at", "is not", null)
      .orderBy("version", "desc")
      .limit(1)
      .executeTakeFirst();

    return row ? mapWorkflowDefinitionVersionRecord(row) : null;
  });
}

/**
 * The edit history, newest first, without the graphs. A definition accumulates
 * a version per save, so returning the documents here would make opening a
 * history panel pay for every draft anyone ever wrote.
 */
export async function listWorkflowDefinitionVersions(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  definitionId: string,
): Promise<WorkflowDefinitionVersionSummary[]> {
  if (!isUuid(definitionId)) return [];

  return withDbSession(db, session, async (trx, scoped) => {
    if (!(await isDefinitionVisible(trx, scoped, definitionId))) return [];

    const rows = await selectVersionSummaries(trx, scoped.tenantId, definitionId)
      .orderBy("version", "desc")
      .execute();

    return rows.map(mapWorkflowDefinitionVersionSummary);
  });
}
