// SPDX-License-Identifier: BUSL-1.1
/**
 * The INVERSE of the record-action point lookup: not "may this application act
 * on this record" but "which records has this application been given an action
 * on, of those I am allowed to see and manage".
 *
 * Why this is a read model and not a store
 * ----------------------------------------
 * The rights stay where they already are — the record's own ACL, under its
 * `actions` member. Nothing here keeps a second copy, an index or a cache of
 * who may do what, because a second copy is a second answer, and two answers
 * to an authorization question is one too many. Every row below is computed
 * from the ACL of a record the session is reading right now.
 *
 * How visibility is bounded
 * -------------------------
 * There is no privileged scan and no definer role in this path. The query runs
 * as the ordinary app role in the session's own transaction, so:
 *
 *   - the entity's row-scope policy decides which rows exist at all. A record
 *     this session may not `view` is not a row it can read, so an assignment
 *     on it is not reported and not counted. That is reported explicitly
 *     rather than implied — see {@link AssignmentVisibility};
 *   - the entity's own read roles are required before its table is consulted,
 *     so raw SQL does not become a way around the role gate the generated list
 *     Operation applies;
 *   - the tenant is the session's, written into the predicate as well as
 *     enforced by the policy;
 *   - the ACL column is READ but never returned. What leaves this module per
 *     row is one boolean per declared action, derived centrally by
 *     `app.record_action_integration_actions`, plus whether the session may
 *     edit the record. Who else holds what on that record is not projected,
 *     so a manager of one integration learns nothing about another;
 *
 *     This read does NOT consult the ACL field's own read policy, and that is
 *     the contract rather than an oversight. Whether one named integration
 *     holds one declared action on a record is integration-management
 *     information, and the authority for it is the integration-management
 *     authority this surface takes before it opens a transaction
 *     (authority.ts) — the same authority the change itself takes. A
 *     deployment that classifies the ACL field is withholding the DOCUMENT
 *     from ordinary readers, which this surface honours by never returning
 *     it; it is not thereby withholding the estate of an integration's reach
 *     from the person who provisions integrations. The per-row disclosure is
 *     bounded to exactly that: the declared action names, for the one
 *     integration asked after, on records the session may already read;
 *   - the record's name goes through the entity's own field policy. A
 *     classified or policy-restricted name is withheld and the row says so.
 *
 * Paging
 * ------
 * Keyset, over (entity, record id, action). The entity order is the
 * registry's, the record order is the primary key's own `uuid` order, and a
 * record may contribute several actions, so a cursor names all three and a
 * page can resume in the middle of one record. The cursor names the LAST row
 * returned, never the next one: the next row may be gone by the time the page
 * after it is asked for, while the last one returned is a position the caller
 * has already seen.
 *
 * The key is compared and ordered as `uuid` rather than as text precisely so
 * the primary-key index stays usable; casting it would have forced a sort of
 * the whole tenant partition on every page.
 *
 * Bounding the scan
 * -----------------
 * Each page reads at most `limit + 1` MATCHING records per entity it touches
 * and stops at the first entity that fills the page. "Matching" is the part
 * that has to be indexed: grants are sparse, so a predicate that only the
 * ACL-reading function could decide would make every page a full tenant scan.
 * The statement therefore also carries an index-eligible containment
 * pre-filter — one `@>` per declared action being asked after, served by the
 * `jsonb_path_ops` GIN index on the ACL column
 * (db/migrations/record-actions.ts). The authoritative test remains
 * `app.record_action_integration_actions`, which the pre-filter cannot widen:
 * containment matches a superset, and the function then decides.
 *
 * Both regimes were measured on PG17 over 40 000 records of one tenant, and
 * the planner picks per selectivity rather than being steered:
 *
 *   5 grants      BitmapOr of two Bitmap Index Scans on the GIN index, 1 heap
 *                 block, ~2 ms. The sparse case the index exists for;
 *   30 000 grants ordered Index Scan on the primary key with the containment
 *                 as a filter, 15 rows removed for 26 returned, ~6 ms. No
 *                 sort: with the keyset already ordered by the key, dense
 *                 grants make the ordered scan the cheaper plan.
 *
 * So neither "sparse grants in a large tenant" nor "an integration granted
 * nearly everything" reads the tenant to answer one page.
 */
import { operationFailure } from "@openshapeforge/operations";
import { sql, type Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import type { DB } from "../../generated/db/types.js";
import { withDbSession, type DbSessionInput } from "../../db/session.js";
import { redactRow } from "../../graphql/generated-authz.js";
import { requireEntityOperation } from "../entity/catalog.js";
import { fieldNameForColumn } from "../entity/columns.js";
import { subtypeScopeWhere } from "../entity/subtype-scope.js";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import {
  recordActionAssignmentEntities,
  type RecordActionAssignmentEntity,
} from "./registry.js";
import { formatAssignmentLocator } from "./locator.js";
import { requireTenantIntegration } from "./integration.js";
import { assertAssignmentManagerAuthority } from "./authority.js";

const ACTION_NAME = /^[a-z][A-Za-z0-9]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
/** One extra row detects overflow; another preserves an inclusive resume anchor. */
const MAX_RECORDS_PER_ENTITY = MAX_PAGE_SIZE + 2;

export type AssignmentRow = {
  id: string;
  entity: string;
  entityLabel: string;
  recordId: string;
  recordName: string;
  /** True when the entity has a name the session may not read; `recordName` is the key. */
  nameWithheld: boolean;
  action: string;
  integrationId: string;
  /** Whether THIS session may change this assignment, not whether anyone may. */
  manageable: boolean;
  /** The record's optimistic-concurrency token, when the entity stores one. */
  version: string | null;
};

/**
 * The boundary the rows were selected within, stated rather than implied.
 *
 * There is deliberately no "complete" flag. The listing cannot know whether
 * an assignment exists on a record the row-scope policy hides from it — the
 * row simply does not exist in its transaction — so any claim of totality
 * would be a claim this surface is not in a position to make. What it CAN say
 * it says: the scope the rows came from, which action-capable entities its own
 * roles kept out, and whether a name was withheld. Everything else is
 * unknown and reported as nothing rather than as absence.
 */
export type AssignmentVisibility = {
  /**
   * Constant, and the whole point: these are the assignments on records this
   * session may read. Not the tenant's assignments.
   */
  scope: "readable-records";
  /** Action-capable entities this session's roles kept out of the listing. */
  omittedEntities: Array<{ entity: string; reason: "no-read-authority" }>;
  /** At least one row's name was withheld by the entity's field policy. */
  namesWithheld: boolean;
};

export type AssignmentPage = {
  assignments: AssignmentRow[];
  nextCursor: string | null;
  /** Always null: a count over records the session cannot read would be a scan. */
  totalCount: null;
  visibility: AssignmentVisibility;
};

export type AssignmentQuery = {
  integrationId: string;
  /** Narrow to one entity; absent reads every entity in registry order. */
  entity?: string | undefined;
  /** Narrow to one declared action name. */
  action?: string | undefined;
  /** Narrow to one record key; the keyset no longer applies. */
  recordId?: string | undefined;
  first?: number | undefined;
  after?: string | undefined;
  direction?: "asc" | "desc" | undefined;
};

type Cursor = { entity: string; recordId: string; action: string };

/** VALIDATION, the code the catalog declares for an input this surface refuses. */
function badInput(message: string): Error {
  return operationFailure({ code: "VALIDATION", message, retryable: false });
}

export function encodeAssignmentCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.entity, cursor.recordId, cursor.action]), "utf8")
    .toString("base64url");
}

export function decodeAssignmentCursor(value: unknown): Cursor | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 4096) throw badInput("The cursor is not valid.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw badInput("The cursor is not valid.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 3 || parsed.some((part) => typeof part !== "string")) {
    throw badInput("The cursor is not valid.");
  }
  const [entity, recordId, action] = parsed as [string, string, string];
  return { entity, recordId, action };
}

function pageSize(first: number | undefined): number {
  if (first === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(first) || first < 1 || first > MAX_PAGE_SIZE) {
    throw badInput(`first must be an integer between 1 and ${MAX_PAGE_SIZE}.`);
  }
  return first;
}

/**
 * The declared action names as one Postgres array literal.
 *
 * Every name came from the compiled manifest and is re-checked against the
 * action pattern here, so nothing that reaches SQL can carry a quote, a comma
 * or a brace. A manifest that disagrees stops the request instead of shaping a
 * statement.
 */
function declaredActionNames(
  entity: RecordActionAssignmentEntity,
  action?: string,
): string[] {
  const names = entity.actions
    .map((declared) => declared.name)
    .filter((name) => action === undefined || name === action);
  for (const name of names) {
    if (!ACTION_NAME.test(name)) {
      throw operationFailure({
        code: "INTERNAL_SERVER_ERROR",
        message: "The record action registry is invalid.",
        retryable: false,
      });
    }
  }
  return names;
}

function declaredActionsLiteral(entity: RecordActionAssignmentEntity, action?: string): string {
  return `{${declaredActionNames(entity, action).join(",")}}`;
}

type RecordCandidate = {
  record_id: string;
  held: string[] | null;
  manageable: boolean | null;
  record_name: unknown;
  version: unknown;
};

/** English label; the field's own title is localized by the Operation schema. */
function entityLabel(entity: RecordActionAssignmentEntity): string {
  return entity.labels.en ?? entity.entity;
}

function timestamp(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * One entity's candidate records, from the cursor's key onwards.
 *
 * `manageable` is the record half of the manage decision only. The entity half
 * — holding the update roles — is decided once per entity by the caller, and
 * both must hold.
 */
async function readCandidates(
  trx: Transaction<DB>,
  session: DbSessionInput,
  entity: RecordActionAssignmentEntity,
  query: { integrationId: string; action?: string | undefined; recordId?: string | undefined },
  after: string | undefined,
  direction: "asc" | "desc",
  limit: number,
): Promise<RecordCandidate[]> {
  const table = entity.table;
  const key = sql.id("row_source", entity.keyColumn);
  const acl = sql.id("row_source", entity.acl.column);
  const ascending = direction === "asc";
  if (query.recordId !== undefined && !UUID.test(query.recordId)) {
    throw badInput("The record identifier is not valid.");
  }
  if (after !== undefined && !UUID.test(after)) throw badInput("The cursor is not valid.");
  // `>=` / `<=`: the cursor's own record may still owe actions to this page.
  // Compared as `uuid`, which is what the primary key is indexed as.
  const keysetWhere = query.recordId !== undefined
    ? sql`and ${key} = ${query.recordId}::uuid`
    : after === undefined
      ? sql``
      : ascending
        ? sql`and ${key} >= ${after}::uuid`
        : sql`and ${key} <= ${after}::uuid`;
  const order = ascending ? sql`asc` : sql`desc`;
  // The index-eligible half of "holds one of these actions": containment of
  // the one path a grant writes. OR-chained rather than `= any(...)` so the
  // planner can take a BitmapOr over the GIN index instead of a filter.
  const held = declaredActionNames(entity, query.action);
  // An action filter this entity does not declare narrows to nothing. Returned
  // here rather than as an empty predicate: a surface that distinguished "no
  // such action on this entity" from "no assignments" would report the
  // deployment's manifest to anyone who asked.
  if (held.length === 0) return [];
  // The document is passed as an OBJECT, not as a JSON string: the driver
  // serializes a JS string into a jsonb string SCALAR, so `@> '"{...}"'`
  // silently matches nothing. Proven the hard way; left stated so it is not
  // re-introduced by a stringify that looks tidier.
  const containment = sql.join(
    held.map((action) =>
      sql`${acl} @> ${{ actions: { [action]: { integrations: [query.integrationId] } } }}::jsonb`),
    sql` or `,
  );
  const name = entity.nameColumn
    ? sql`${sql.id("row_source", entity.nameColumn.name)}`
    : sql`null`;
  const version = entity.versionColumn
    ? sql`${sql.id("row_source", entity.versionColumn.name)}`
    : sql`null`;
  const result = await sql<RecordCandidate>`
    select ${key}::text as record_id,
           held.actions as held,
           app.record_permission_allows(${acl}, 'edit', ${entity.acl.empty === "public"}) as manageable,
           ${name} as record_name,
           ${version} as version
      from ${sql.id(table.schema, table.table)} as row_source
      cross join lateral (
        select app.record_action_integration_actions(
          ${acl}, ${query.integrationId}, ${declaredActionsLiteral(entity, query.action)}::text[]
        ) as actions
      ) as held
     where ${sql.id("row_source", "tenant_id")} = ${session.tenantId}
       ${keysetWhere}
       ${subtypeScopeWhere(table, "row_source")}
       and (${containment})
       and cardinality(held.actions) > 0
     order by ${key} ${order}
     limit ${limit}
  `.execute(trx);
  return result.rows;
}

/**
 * The record's name as this session may read it.
 *
 * The same redaction the generated read path applies, on the one column, so a
 * classified or policy-restricted name is withheld here exactly as it would be
 * in the entity's own list. The key stands in for it rather than a blank, so
 * the row remains identifiable and actionable.
 */
export function recordNameForSession(
  entity: RecordActionAssignmentEntity,
  session: TrustedSessionContext,
  candidate: Pick<RecordCandidate, "record_id" | "record_name">,
): { recordName: string; nameWithheld: boolean } {
  const column = entity.nameColumn;
  if (!column) return { recordName: candidate.record_id, nameWithheld: false };
  const redacted = redactRow(
    { [column.name]: candidate.record_name },
    entity.table.columns,
    entity.table.source?.authorization,
    session,
  );
  const value = redacted[column.name];
  if (typeof value === "string" && value.length > 0) {
    return { recordName: value, nameWithheld: false };
  }
  // A withheld name and a genuinely empty one are not the same thing: only the
  // first is reported as withheld, and only when the stored value was present.
  const withheld = value !== candidate.record_name &&
    typeof candidate.record_name === "string" && candidate.record_name.length > 0;
  return { recordName: candidate.record_id, nameWithheld: withheld };
}

/**
 * The assignments one integration holds, as this session may see them.
 *
 * The subject is resolved before anything else: an id that is not an
 * integration of this session's tenant is refused rather than answered.
 */
export async function listRecordActionAssignments(
  db: OpenShapeForgeDatabase,
  session: TrustedSessionContext & DbSessionInput,
  query: AssignmentQuery,
): Promise<AssignmentPage> {
  // The same authority the change takes, before any record is consulted: a
  // session that may not manage an integration's reach may not survey it
  // either (authority.ts).
  assertAssignmentManagerAuthority(session);
  const limit = pageSize(query.first);
  const cursor = decodeAssignmentCursor(query.after);
  const direction = query.direction === "desc" ? "desc" : "asc";
  if (query.action !== undefined && !ACTION_NAME.test(query.action)) {
    throw badInput("The action is not a declared action name.");
  }

  const registry = recordActionAssignmentEntities();
  // An entity outside the registry carries no manageable assignment at all,
  // so it narrows the listing to nothing. It is not a refusal: the registry is
  // deployment state, and a surface that distinguished "no such entity" from
  // "no assignments" would report that state to anyone who asked.
  const requested = query.entity === undefined
    ? registry
    : registry.filter((entity) => entity.entity === query.entity);
  const ordered = direction === "asc" ? requested : [...requested].reverse();

  const omittedEntities: AssignmentVisibility["omittedEntities"] = [];
  const readable = ordered.filter((entity) => {
    try {
      requireEntityOperation(entity.table, "list", session);
      return true;
    } catch {
      omittedEntities.push({ entity: entity.entity, reason: "no-read-authority" });
      return false;
    }
  });

  return withDbSession(db, session, async (trx, resolvedSession) => {
    // The subject is the server's to resolve, not the caller's to assert: an
    // id that is not an integration of THIS tenant is refused rather than
    // answered with an empty page, so the surface cannot be used to ask after
    // an integration the session has no business naming.
    await requireTenantIntegration(trx, resolvedSession, query.integrationId);
    const assignments: AssignmentRow[] = [];
    let nextCursor: string | null = null;
    let namesWithheld = false;
    // The cursor names the LAST row returned, never the next one: the next row
    // may be gone by the time the page after it is asked for, while the last
    // one returned is a position the caller has already seen.
    let last: Cursor | undefined;

    const startIndex = cursor
      ? readable.findIndex((entity) => entity.entity === cursor.entity)
      : 0;
    // A cursor naming an entity this session can no longer read restarts at
    // the next entity rather than silently rewinding to the first.
    const resumeAt = startIndex >= 0 ? startIndex : nextEntityIndex(readable, cursor, direction);

    for (let index = resumeAt; index < readable.length && nextCursor === null; index += 1) {
      const entity = readable[index]!;
      const manageableEntity = holdsUpdateRoles(entity, session);
      const after = cursor && cursor.entity === entity.entity ? cursor.recordId : undefined;
      // The inclusive keyset can return the cursor record even when all of its
      // actions have already been consumed. Reserve one extra candidate for it
      // so the overflow row remains visible on a resumed page.
      const want = Math.min(limit + 1 - assignments.length + (after !== undefined ? 1 : 0), MAX_RECORDS_PER_ENTITY);
      const candidates = await readCandidates(
        trx, resolvedSession, entity, query, after, direction, want,
      );
      for (const candidate of candidates) {
        const held = [...(candidate.held ?? [])].sort();
        const names = direction === "asc" ? held : [...held].reverse();
        for (const action of names) {
          if (after !== undefined && candidate.record_id === after && cursor &&
            (direction === "asc" ? action <= cursor.action : action >= cursor.action)) {
            continue;
          }
          if (assignments.length === limit) {
            nextCursor = encodeAssignmentCursor(last!);
            break;
          }
          const { recordName, nameWithheld } = recordNameForSession(entity, session, candidate);
          if (nameWithheld) namesWithheld = true;
          assignments.push({
            id: formatAssignmentLocator({
              entity: entity.entity,
              recordId: candidate.record_id,
              action,
              integrationId: query.integrationId,
            }),
            entity: entity.entity,
            entityLabel: entityLabel(entity),
            recordId: candidate.record_id,
            recordName,
            nameWithheld,
            action,
            integrationId: query.integrationId,
            manageable: manageableEntity && candidate.manageable === true,
            version: timestamp(candidate.version),
          });
          last = { entity: entity.entity, recordId: candidate.record_id, action };
        }
        if (nextCursor !== null) break;
      }
    }

    return {
      assignments,
      nextCursor,
      totalCount: null,
      visibility: { scope: "readable-records", omittedEntities, namesWithheld },
    };
  });
}

/**
 * One assignment, read the same way the listing reads it.
 *
 * Same boundaries, same refusal: the entity's read roles, the record's own
 * row-scope policy and the tenant predicate decide, and an assignment that is
 * absent, another tenant's, unreadable or no longer granted is one answer —
 * undefined — so the single read cannot distinguish what the listing hides.
 */
export async function readRecordActionAssignment(
  db: OpenShapeForgeDatabase,
  session: TrustedSessionContext & DbSessionInput,
  locator: { entity: string; recordId: string; action: string; integrationId: string },
): Promise<AssignmentRow | undefined> {
  const page = await listRecordActionAssignments(db, session, {
    integrationId: locator.integrationId,
    entity: locator.entity,
    action: locator.action,
    recordId: locator.recordId,
    first: 1,
  });
  return page.assignments[0];
}

/** Where to resume when the cursor's entity is no longer part of the listing. */
function nextEntityIndex(
  readable: readonly RecordActionAssignmentEntity[],
  cursor: Cursor | undefined,
  direction: "asc" | "desc",
): number {
  if (!cursor) return 0;
  const index = readable.findIndex((entity) =>
    direction === "asc" ? entity.entity > cursor.entity : entity.entity < cursor.entity);
  return index >= 0 ? index : readable.length;
}

function holdsUpdateRoles(
  entity: RecordActionAssignmentEntity,
  session: DbSessionInput,
): boolean {
  try {
    requireEntityOperation(entity.table, "update", session);
    return true;
  } catch {
    return false;
  }
}
