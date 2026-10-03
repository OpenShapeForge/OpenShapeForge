// SPDX-License-Identifier: BUSL-1.1
/**
 * The core `osf-source-sync` runtime: keeping records in step with an external
 * source system by the base source fields every entity carries
 * (packages/compiler/config/authoring/operations/source-sync.yaml).
 *
 * A record is identified by (tenant, sourceAuthority, sourceAdministration,
 * externalId). Writes go through the entity's ordinary create/update/delete,
 * so its roles, validation, record permissions, events and deletion guards
 * all apply; the Operation itself only matches, resolves references and keeps
 * a page atomic. The watermark is read back from sourceVersion, never stored.
 */
import { operationFailure } from "@openshapeforge/operations";
import { sql, type Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import type { DB } from "../generated/db/types.js";
import type { ModuleOperationHandler } from "../modules/contract.js";
import { getGeneratedCrudTables, requireEntityOperation } from "./entity/catalog.js";
import { createGeneratedEntity, deleteGeneratedEntity, updateGeneratedEntity } from "./entity/mutations.js";
import type { GeneratedCrudTable } from "./entity/types.js";
import type { OperationContract } from "./runtime.js";

/** The plugin name the source-sync Operations are authored under; matches the compiler's. */
export const SOURCE_SYNC_PLUGIN = "osf-source-sync";

const MAX_RECORDS = 1000;
const REFERENCE_SUFFIX = "ExternalId";
type Rec = Record<string, unknown>;
type Source = { table: GeneratedCrudTable; authority: string; administration: string };
type Stored = { id: string; external_id: string; source_version: string | null };

function badInput(message: string): Error {
  return operationFailure({ code: "BAD_USER_INPUT", message });
}

function isRecord(value: unknown): value is Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw badInput(`${name} must be a non-empty string.`);
  return value;
}

function entityTable(entity: string): GeneratedCrudTable {
  const table = getGeneratedCrudTables().find((candidate) =>
    candidate.source?.authoringEntityName === entity && candidate.tenantScoped && Boolean(candidate.primaryKey));
  if (!table) throw badInput(`Entity ${JSON.stringify(entity)} is not a tenant entity that can be synchronised.`);
  return table;
}

function sourceOf(input: Rec): Source {
  return {
    table: entityTable(text(input.entity, "entity")),
    authority: text(input.sourceAuthority, "sourceAuthority"),
    administration: text(input.sourceAdministration, "sourceAdministration"),
  };
}

function requireSession(context: Parameters<ModuleOperationHandler>[1]): { db: OpenShapeForgeDatabase; session: DbSessionInput } {
  const { db, session } = context;
  if (!db) throw operationFailure({ code: "DATABASE_NOT_CONFIGURED", message: "The database is unavailable.", retryable: true });
  if (!session?.tenantId) throw operationFailure({ code: "UNAUTHENTICATED", message: "An authenticated tenant session is required." });
  return { db, session };
}

/** One import per source at a time: two runs of the same page cannot both create a record. */
async function lockSource(trx: Transaction<DB>, session: DbSessionInput, source: Source): Promise<void> {
  // JSON, not a joined string: authority and administration are free text.
  const key = JSON.stringify(["source-sync", session.tenantId, source.table.name, source.authority, source.administration]);
  await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx);
}

/** Stored rows of one source by externalId; more than one row for an id is ambiguous. */
async function storedByExternalId(
  trx: Transaction<DB>,
  session: DbSessionInput,
  source: Source,
  externalIds: readonly string[],
): Promise<Map<string, Stored>> {
  if (externalIds.length === 0) return new Map();
  const result = await sql<Stored>`
    select ${sql.id(source.table.primaryKey!)}::text as id, external_id, source_version
      from ${sql.id(source.table.schema, source.table.table)}
     where tenant_id = ${session.tenantId}::uuid
       and source_authority = ${source.authority}
       and source_administration = ${source.administration}
       and external_id in (select jsonb_array_elements_text(${JSON.stringify(externalIds)}::text::jsonb))
  `.execute(trx);
  const found = new Map<string, Stored>();
  for (const row of result.rows) {
    if (found.has(row.external_id)) {
      throw badInput(`${source.table.source?.authoringEntityName} ${JSON.stringify(row.external_id)} exists more than once for this source.`);
    }
    found.set(row.external_id, row);
  }
  return found;
}

/** `<field>ExternalId` → `<field>Id`, resolved against the reference's entity with the same source. */
async function resolveReferences(
  trx: Transaction<DB>,
  session: DbSessionInput,
  source: Source,
  records: readonly Rec[],
): Promise<Rec[]> {
  const relationships = source.table.source?.graphql?.relationships ?? [];
  const wanted = new Map<string, { target: GeneratedCrudTable; ids: Set<string> }>();
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (key === "externalId" || !key.endsWith(REFERENCE_SUFFIX)) continue;
      const fieldKey = `${key.slice(0, -REFERENCE_SUFFIX.length)}Id`;
      const relationship = relationships.find((candidate) => candidate.fieldKey === fieldKey && candidate.resolve === "belongsTo");
      if (!relationship) throw badInput(`${key} names no reference ${fieldKey} on ${source.table.source?.authoringEntityName}.`);
      const entry = wanted.get(fieldKey) ?? { target: entityTable(relationship.target), ids: new Set<string>() };
      if (value !== null && value !== undefined && value !== "") entry.ids.add(text(value, key));
      wanted.set(fieldKey, entry);
    }
  }
  const resolved = new Map<string, Map<string, Stored>>();
  for (const [fieldKey, { target, ids }] of wanted) {
    // Reading the referenced entity needs its list role; clearing a reference reads nothing.
    if (ids.size === 0) continue;
    requireEntityOperation(target, "list", session);
    resolved.set(fieldKey, await storedByExternalId(trx, session, { ...source, table: target }, [...ids]));
  }
  return records.map((record) => Object.fromEntries(Object.entries(record).map(([key, value]) => {
    if (key === "externalId" || !key.endsWith(REFERENCE_SUFFIX)) return [key, value];
    const fieldKey = `${key.slice(0, -REFERENCE_SUFFIX.length)}Id`;
    if (value === null || value === undefined || value === "") return [fieldKey, null];
    const target = resolved.get(fieldKey)?.get(String(value));
    if (!target) throw badInput(`${key} ${JSON.stringify(value)} is not available for this source; import it first.`);
    return [fieldKey, target.id];
  })));
}

/** A record's own source fields may repeat the call's, never contradict them. */
function sourceValues(record: Rec, source: Source): Rec {
  for (const [field, expected] of [["sourceAuthority", source.authority], ["sourceAdministration", source.administration]] as const) {
    const value = record[field];
    if (value !== undefined && value !== null && String(value) !== expected) {
      throw badInput(`Record ${JSON.stringify(record.externalId)} has ${field} ${JSON.stringify(value)}, not ${JSON.stringify(expected)}.`);
    }
  }
  return { ...record, sourceAuthority: source.authority, sourceAdministration: source.administration };
}

const upsertBySource: ModuleOperationHandler = async (input, context) => {
  const { db, session } = requireSession(context);
  const source = sourceOf(input);
  if (!Array.isArray(input.records) || input.records.length > MAX_RECORDS) {
    throw badInput(`records must be an array of at most ${MAX_RECORDS} records.`);
  }
  const records = input.records.map((record, index) => {
    if (!isRecord(record)) throw badInput(`records[${index}] must be an object.`);
    text(record.externalId, `records[${index}].externalId`);
    return record;
  });
  const externalIds = records.map((record) => String(record.externalId));
  const repeated = externalIds.find((id, index) => externalIds.indexOf(id) !== index);
  if (repeated !== undefined) throw badInput(`externalId ${JSON.stringify(repeated)} appears more than once in this page.`);

  const value = await withDbSession(db, session, async (trx) => {
    await lockSource(trx, session, source);
    const stored = await storedByExternalId(trx, session, source, externalIds);
    const prepared = await resolveReferences(trx, session, source, records);
    let created = 0, updated = 0, skipped = 0;
    let highest: string | null = null;
    for (const record of prepared) {
      const values = sourceValues(record, source);
      const version = typeof values.sourceVersion === "string" ? values.sourceVersion : null;
      if (version !== null && (highest === null || version > highest)) highest = version;
      const existing = stored.get(String(values.externalId));
      if (!existing) {
        await createGeneratedEntity(db, session, { table: source.table.name, values });
        created += 1;
      } else if (version !== null && existing.source_version !== null && existing.source_version > version) {
        skipped += 1;
      } else {
        await updateGeneratedEntity(db, session, { table: source.table.name, id: existing.id, values });
        updated += 1;
      }
    }
    return { created, updated, skipped, highestSourceVersion: highest };
  });
  return { value, status: 200 };
};

/** The next "changed since" for the source: a padded integer without its padding, else the stored value. */
export function sinceFromSourceVersion(version: string | null): string | null {
  if (version === null) return null;
  return /^\d+$/.test(version) ? version.replace(/^0+(?=\d)/, "") : version;
}

const sourceWatermark: ModuleOperationHandler = async (input, context) => {
  const { db, session } = requireSession(context);
  const names = Array.isArray(input.entity) ? input.entity : [input.entity];
  const tables = [...new Set(names.map((name, index) => entityTable(text(name, `entity[${index}]`))))];
  const authority = text(input.sourceAuthority, "sourceAuthority");
  const administration = text(input.sourceAdministration, "sourceAdministration");
  for (const table of tables) requireEntityOperation(table, "list", session);
  const version = await withDbSession(db, session, async (trx) => {
    let highest: string | null = null;
    for (const table of tables) {
      // Byte order, whatever the database collation: sourceVersion is written
      // to sort as plain text, across entities of one source as within one.
      const result = await sql<{ source_version: string }>`
        select source_version
          from ${sql.id(table.schema, table.table)}
         where tenant_id = ${session.tenantId}::uuid
           and source_authority = ${authority}
           and source_administration = ${administration}
           and source_version is not null
         order by source_version collate "C" desc
         limit 1
      `.execute(trx);
      const candidate = result.rows[0]?.source_version ?? null;
      if (candidate !== null && (highest === null || candidate > highest)) highest = candidate;
    }
    return highest;
  });
  const initial = typeof input.initial === "string" ? input.initial : null;
  return { value: { since: sinceFromSourceVersion(version) ?? initial, sourceVersion: version }, status: 200 };
};

/** The ids to remove: externalIds as given, or the records that name this entity (or none). */
function removalIds(input: Rec, entity: string): string[] {
  if (Array.isArray(input.records) === Array.isArray(input.externalIds)) {
    throw badInput("Give either externalIds or records.");
  }
  const ids = Array.isArray(input.externalIds)
    ? input.externalIds.map((id, index) => text(id, `externalIds[${index}]`))
    : (input.records as unknown[]).flatMap((record, index) => {
      if (!isRecord(record)) throw badInput(`records[${index}] must be an object.`);
      if (record.entity !== undefined && record.entity !== null && record.entity !== entity) return [];
      if (record.entity === null) return [];
      return [text(record.externalId, `records[${index}].externalId`)];
    });
  if (ids.length > MAX_RECORDS) throw badInput(`At most ${MAX_RECORDS} ids per call.`);
  return [...new Set(ids)];
}

const removeBySource: ModuleOperationHandler = async (input, context) => {
  const { db, session } = requireSession(context);
  const source = sourceOf(input);
  const externalIds = removalIds(input, text(input.entity, "entity"));
  const removed = await withDbSession(db, session, async (trx) => {
    await lockSource(trx, session, source);
    const stored = await storedByExternalId(trx, session, source, externalIds);
    for (const row of stored.values()) {
      await deleteGeneratedEntity(db, session, { table: source.table.name, id: row.id });
    }
    return stored.size;
  });
  return { value: { removed }, status: 200 };
};

/** Ordered related batches form one page: no partial write can advance its watermark. */
const applySourcePage: ModuleOperationHandler = async (input, context) => {
  const { db, session } = requireSession(context);
  if (!Array.isArray(input.batches) || input.batches.length < 1 || input.batches.length > 10) {
    throw badInput("batches must contain 1 to 10 entity batches.");
  }
  let total = 0;
  const batches = input.batches.map((batch) => {
    if (!isRecord(batch) || !Array.isArray(batch.records) || !["upsert", "remove"].includes(String(batch.action))) {
      throw badInput("Each batch needs entity, action (upsert/remove) and records.");
    }
    const source = sourceOf({ ...input, entity: batch.entity });
    const records = batch.action === "remove" ? batch.records.filter((record) => {
      if (!isRecord(record)) throw badInput("Each removal record must be an object.");
      return record.entity === undefined || record.entity === batch.entity;
    }) : batch.records;
    total += records.length;
    if (total > 10_000) throw badInput("A source page may contain at most 10000 records across its batches.");
    if (batch.action === "upsert") {
      const ids = batch.records.map((record) => {
        if (!isRecord(record)) throw badInput("Each upsert record must be an object.");
        return text(record.externalId, "externalId");
      });
      if (new Set(ids).size !== ids.length) throw badInput("Duplicate externalId in an upsert batch.");
    }
    return { entity: text(batch.entity, "entity"), action: batch.action, source, records };
  });
  if (new Set(batches.map((batch) => batch.source.table.name)).size !== batches.length) {
    throw badInput("Each entity may occur only once in a source page.");
  }
  const results = await withDbSession(db, session, async (trx) => {
    // Canonical lock order prevents opposite dependency orders from deadlocking.
    for (const batch of [...batches].sort((a, b) => a.source.table.name.localeCompare(b.source.table.name))) {
      await lockSource(trx, session, batch.source);
    }
    const results: Rec[] = [];
    for (const batch of batches) {
      const chunks: unknown[] = [];
      const handler = batch.action === "upsert" ? upsertBySource : removeBySource;
      for (let offset = 0; offset < batch.records.length; offset += MAX_RECORDS) {
        const result = await handler({
          entity: batch.entity, sourceAuthority: batch.source.authority,
          sourceAdministration: batch.source.administration,
          records: batch.records.slice(offset, offset + MAX_RECORDS),
        }, context);
        if (!("value" in result)) throw operationFailure({ code: result.code, message: "Source batch failed; the page was rolled back." });
        chunks.push(result.value);
      }
      results.push({ entity: batch.entity, action: batch.action, chunks });
    }
    return results;
  });
  return { value: { batches: results }, status: 200 };
};

const HANDLERS: Record<string, ModuleOperationHandler> = { upsertBySource, sourceWatermark, removeBySource, applySourcePage };

export function sourceSyncOperationHandlerNames(): readonly string[] {
  return Object.keys(HANDLERS).sort();
}

export function sourceSyncOperationHandler(
  operation: Pick<OperationContract, "key" | "handler">,
): ModuleOperationHandler {
  const run = HANDLERS[operation.handler];
  if (!run) throw new Error(`Unknown core source-sync handler "${operation.handler}" for "${operation.key}".`);
  return run;
}
