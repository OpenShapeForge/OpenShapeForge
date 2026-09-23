// SPDX-License-Identifier: BUSL-1.1
/**
 * Reverse-map revalidation of published derived-tool owners.
 *
 * A write on a binding row, or on an operation/provider/connection the
 * chain depends on, is refused with NOT_PUBLISHABLE when it would leave a
 * published owner unexecutable. Runs inside the write transaction with the
 * owner locked FOR UPDATE so two sessions cannot both delete the last two
 * bindings.
 */
import { sql, type Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import type { DB } from "../../generated/db/types.js";
import { currentDbSessionDatabase, type DbSessionInput } from "../../db/session.js";
import {
  catalogDerivedTools,
  entityForTable,
  catalog,
  catalogDiscoveryTools,
  catalogGuideTools,
  catalogTestTools,
} from "../../mcp/catalog.js";
import type { DerivedToolsCatalogEntry } from "../../mcp/derived-tools.js";
import type { ExecutionCatalogEntry } from "../../mcp/declarative-execution.js";
import {
  BindingOverflowError,
  MAX_BINDINGS_PER_OWNER,
  readAllRelationRows,
  type BindingRowReader,
} from "../../mcp/execution-bindings.js";
import {
  validateVisibleDefinition,
  type PublicationRowReader,
} from "../../mcp/publication-validation.js";
import { runtimeBindingReader, runtimeRowsByFilter } from "../../mcp/session-connections.js";
import { HttpError } from "../../rest/http-error.js";
import { generatedCrudError, getGeneratedCrudTables } from "./catalog.js";
import { fieldNameForColumn } from "./columns.js";
import type { GeneratedCrudTable, GeneratedEntityRow } from "./types.js";

export type BindingRowOverlay =
  | { kind: "create"; row: Record<string, unknown> }
  | { kind: "update"; id: string; before: Record<string, unknown>; after: Record<string, unknown> }
  | { kind: "delete"; id: string; row: Record<string, unknown> };

export type ReferencedRowOverlay =
  | { kind: "update"; id: string; after: Record<string, unknown> }
  | { kind: "delete"; id: string };

function serializeRow(table: GeneratedCrudTable, row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    table.columns.map((column) => [fieldNameForColumn(column), row[column.name]]),
  );
}

function tablesMap(tables?: readonly GeneratedCrudTable[]): Map<string, GeneratedCrudTable> {
  return new Map((tables ?? getGeneratedCrudTables()).map((table) => [table.name, table]));
}

function requireDb(db?: OpenShapeForgeDatabase): OpenShapeForgeDatabase {
  const active = db ?? (currentDbSessionDatabase() as OpenShapeForgeDatabase | undefined);
  if (!active) {
    throw generatedCrudError(
      "Derived-tool revalidation requires the active write transaction.",
      "INTERNAL_SERVER_ERROR",
    );
  }
  return active;
}

function reservedDerivedToolNames(): Set<string> {
  return new Set<string>([
    ...catalog.tools.map((tool) => tool.name),
    ...catalogDerivedTools.flatMap((candidate) => [
      ...(candidate.connect ? [candidate.connect.name] : []),
      ...(candidate.dryRun ? [candidate.dryRun.name] : []),
      ...(candidate.personalization ? [candidate.personalization.set.name] : []),
    ]),
    ...catalogGuideTools.map((tool) => tool.name),
    ...catalogDiscoveryTools.map((tool) => tool.name),
    ...catalogTestTools.map((tool) => tool.name),
  ]);
}

function isPublishedOwner(
  entry: DerivedToolsCatalogEntry,
  row: Record<string, unknown>,
): boolean {
  const gate = entry.visibleWhen;
  if (!gate) return false;
  return row[gate.field] === gate.equals;
}

export function derivedToolEntriesForBindingTable(
  table: string,
  entries: readonly DerivedToolsCatalogEntry[] = catalogDerivedTools,
): DerivedToolsCatalogEntry[] {
  return entries.filter(
    (entry) =>
      entry.visibleWhen &&
      entry.execution &&
      entry.execution.bindingsTable === table,
  );
}

export function derivedToolEntriesForReferencedTable(
  table: string,
  entries: readonly DerivedToolsCatalogEntry[] = catalogDerivedTools,
): DerivedToolsCatalogEntry[] {
  return entries.filter((entry) => {
    const execution = entry.execution;
    if (!entry.visibleWhen || !execution) return false;
    return (
      execution.operationTable === table ||
      execution.providerTable === table ||
      execution.connectionTable === table
    );
  });
}

export function bindingOwnerIdsFromOverlay(
  execution: ExecutionCatalogEntry,
  overlay: BindingRowOverlay,
): string[] {
  const parentRef = execution.parentRef;
  if (typeof parentRef !== "string" || parentRef.length === 0) return [];
  const ids = new Set<string>();
  const take = (row: Record<string, unknown>) => {
    const ownerId = row[parentRef];
    if (typeof ownerId === "string" && ownerId.length > 0) ids.add(ownerId);
  };
  if (overlay.kind === "create") take(overlay.row);
  else if (overlay.kind === "delete") take(overlay.row);
  else {
    take(overlay.before);
    take(overlay.after);
  }
  return [...ids];
}

export function applyBindingOverlay(
  rows: readonly Record<string, unknown>[],
  parentRef: string,
  ownerId: string,
  overlay: BindingRowOverlay,
): Record<string, unknown>[] {
  if (overlay.kind === "create") {
    if (overlay.row[parentRef] !== ownerId) return [...rows];
    const id =
      typeof overlay.row.id === "string" && overlay.row.id.length > 0
        ? overlay.row.id
        : "__pending__";
    return [...rows, { ...overlay.row, id }];
  }
  if (overlay.kind === "delete") {
    return rows.filter((row) => row.id !== overlay.id);
  }
  const without = rows.filter((row) => row.id !== overlay.id);
  if (overlay.after[parentRef] !== ownerId) return without;
  return [...without, overlay.after];
}

function overlayBindingReader(
  base: BindingRowReader,
  execution: ExecutionCatalogEntry,
  overlay: BindingRowOverlay,
): BindingRowReader {
  const parentRef = execution.parentRef;
  const bindingsTable = execution.bindingsTable;
  return async (table, filter) => {
    if (table !== bindingsTable) return base(table, filter);
    const rows = await readAllRelationRows(base, table, filter);
    const ownerId = filter[parentRef];
    if (typeof ownerId !== "string") return { rows, nextCursor: null };
    const overlaid = applyBindingOverlay(rows, parentRef, ownerId, overlay);
    if (overlaid.length > MAX_BINDINGS_PER_OWNER) throw new BindingOverflowError();
    return { rows: overlaid, nextCursor: null };
  };
}

function rowMatchesFilter(
  row: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  return Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "in")) {
      const membership = (value as { in?: unknown }).in;
      return Array.isArray(membership) && membership.includes(row[key]);
    }
    return row[key] === value;
  });
}

function overlayRowReader(
  readRows: PublicationRowReader,
  table: string,
  overlay: ReferencedRowOverlay,
): PublicationRowReader {
  return async (rowTable, filter, limit) => {
    const rows = await readRows(rowTable, filter, limit);
    if (rowTable !== table) return rows;
    const without = rows.filter((row) => row.id !== overlay.id);
    if (overlay.kind === "delete") return without;
    return rowMatchesFilter(overlay.after, filter) ? [...without, overlay.after] : without;
  };
}

function rethrowPublishable(error: unknown): never {
  if (error instanceof HttpError && error.code === "NOT_PUBLISHABLE") {
    throw generatedCrudError(error.message, "NOT_PUBLISHABLE");
  }
  throw error;
}

async function lockOwner(
  trx: Transaction<DB>,
  table: GeneratedCrudTable,
  ownerId: string,
  session: DbSessionInput,
): Promise<GeneratedEntityRow | null> {
  const tenantWhere = table.tenantScoped
    ? sql`and ${sql.id("tenant_id")} = ${session.tenantId}`
    : sql``;
  const result = await sql<{ row: GeneratedEntityRow }>`
    select to_jsonb(${sql.id(table.table)}.*) as row
    from ${sql.id(table.schema, table.table)}
    where ${sql.id(table.primaryKey ?? "id")}::text = ${ownerId}
      ${tenantWhere}
    for update
  `.execute(trx);
  return result.rows[0]?.row ?? null;
}

async function pageAll(
  read: BindingRowReader,
  table: string,
  filter: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const collected: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await read(table, filter, { limit: 200, cursor });
    const body = Array.isArray(page) ? page : page.rows;
    const next = Array.isArray(page) ? null : page.nextCursor;
    collected.push(...body);
    if (!next || body.length === 0) return collected;
    if (next === cursor) return collected;
    cursor = next;
  }
}

async function ownerIdsForOperation(
  execution: ExecutionCatalogEntry,
  operationId: string,
  pages: BindingRowReader,
): Promise<string[]> {
  const rows = await pageAll(pages, execution.bindingsTable, {
    [execution.operationRef]: { in: [operationId] },
  });
  return [
    ...new Set(
      rows
        .map((row) => row[execution.parentRef])
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
}

async function ownerIdsForProvider(
  execution: ExecutionCatalogEntry,
  providerId: string,
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  tables: Map<string, GeneratedCrudTable>,
  pages: BindingRowReader,
): Promise<string[]> {
  const operations = await pageAll(
    runtimeBindingReader(db, session, tables),
    execution.operationTable,
    { [execution.providerRef]: providerId },
  );
  const operationIds = operations
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (operationIds.length === 0) return [];
  const rows = await pageAll(pages, execution.bindingsTable, {
    [execution.operationRef]: { in: operationIds },
  });
  return [
    ...new Set(
      rows
        .map((row) => row[execution.parentRef])
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
}

async function revalidatePublishedOwner(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  tables: Map<string, GeneratedCrudTable>,
  trx: Transaction<DB>,
  entry: DerivedToolsCatalogEntry,
  ownerId: string,
  options: {
    overlay?: BindingRowOverlay;
    referenced?: { table: string; overlay: ReferencedRowOverlay };
  },
): Promise<void> {
  const ownerTable = tables.get(entry.table);
  if (!ownerTable) return;
  const current = await lockOwner(trx, ownerTable, ownerId, session);
  if (!current) return;
  const ownerRow = serializeRow(ownerTable, current);
  if (!isPublishedOwner(entry, ownerRow)) return;
  let readRows: PublicationRowReader = (rowTable, filter, limit) =>
    runtimeRowsByFilter(db, session, tables, rowTable, filter, limit);
  if (options.referenced) {
    readRows = overlayRowReader(readRows, options.referenced.table, options.referenced.overlay);
  }
  const pages = runtimeBindingReader(db, session, tables);
  try {
    await validateVisibleDefinition({
      entry,
      row: ownerRow,
      rowId: ownerId,
      reservedNames: reservedDerivedToolNames(),
      providerDefinitionsField: entityForTable(entry.execution!.connectionTable)
        ?.elicitOnCreate?.definitionsField,
      readRows,
      readBindingPages: options.overlay
        ? overlayBindingReader(pages, entry.execution!, options.overlay)
        : pages,
    });
  } catch (error) {
    rethrowPublishable(error);
  }
}

export type RelatedMutation =
  | { kind: "create"; values: Record<string, unknown> }
  | { kind: "update"; id: string; values: Record<string, unknown>; before: Record<string, unknown> }
  | { kind: "delete"; id: string; row: Record<string, unknown> };

/**
 * Revalidate published derived-tool owners affected by a write that is not
 * on the owner table. Call inside the write transaction after the owner
 * (when known) is locked FOR UPDATE.
 */
export async function assertPublishableRelatedMutationInTransaction(
  trx: Transaction<DB>,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  mutation: RelatedMutation,
  options: {
    db?: OpenShapeForgeDatabase;
    tables?: readonly GeneratedCrudTable[];
    entries?: readonly DerivedToolsCatalogEntry[];
  } = {},
): Promise<void> {
  const entries = options.entries ?? catalogDerivedTools;
  const tables = tablesMap(options.tables);
  const db = requireDb(options.db);
  const serialized =
    mutation.kind === "create"
      ? mutation.values
      : mutation.kind === "delete"
        ? mutation.row
        : { ...mutation.before, ...mutation.values };

  type OwnerWork = {
    entry: DerivedToolsCatalogEntry;
    ownerId: string;
    overlay?: BindingRowOverlay;
    referenced?: { table: string; overlay: ReferencedRowOverlay };
  };
  const jobs = new Map<string, OwnerWork>();
  const addWork = (
    entry: DerivedToolsCatalogEntry,
    ownerId: string,
    extra: Partial<Pick<OwnerWork, "overlay" | "referenced">>,
  ) => {
    const key = `${entry.entity}\0${entry.table}\0${ownerId}`;
    const current = jobs.get(key) ?? { entry, ownerId };
    jobs.set(key, { ...current, ...extra });
  };

  const bindingEntries = derivedToolEntriesForBindingTable(table.name, entries);
  if (bindingEntries.length > 0) {
    const overlay: BindingRowOverlay =
      mutation.kind === "create"
        ? { kind: "create", row: serialized }
        : mutation.kind === "delete"
          ? { kind: "delete", id: mutation.id, row: mutation.row }
          : {
              kind: "update",
              id: mutation.id,
              before: mutation.before,
              after: serialized,
            };
    for (const entry of bindingEntries) {
      for (const ownerId of bindingOwnerIdsFromOverlay(entry.execution!, overlay)) {
        addWork(entry, ownerId, { overlay });
      }
    }
  }

  const referenced = derivedToolEntriesForReferencedTable(table.name, entries);
  if (mutation.kind !== "create" && referenced.length > 0) {
    const pages = runtimeBindingReader(db, session, tables);
    const referencedOverlay: ReferencedRowOverlay =
      mutation.kind === "delete"
        ? { kind: "delete", id: mutation.id }
        : { kind: "update", id: mutation.id, after: serialized };
    for (const entry of referenced) {
      const execution = entry.execution!;
      let ownerIds: string[] = [];
      if (execution.operationTable === table.name) {
        ownerIds = await ownerIdsForOperation(execution, mutation.id, pages);
      } else if (execution.providerTable === table.name) {
        ownerIds = await ownerIdsForProvider(
          execution,
          mutation.id,
          db,
          session,
          tables,
          pages,
        );
      } else if (execution.connectionTable === table.name) {
        const providerIds = new Set<string>();
        const takeProvider = (row: Record<string, unknown>) => {
          const providerId = row[execution.connectionProviderRef];
          if (typeof providerId === "string" && providerId.length > 0) {
            providerIds.add(providerId);
          }
        };
        takeProvider(serialized);
        if (mutation.kind === "update") takeProvider(mutation.before);
        const owners = new Set<string>();
        for (const providerId of providerIds) {
          for (const ownerId of await ownerIdsForProvider(
            execution,
            providerId,
            db,
            session,
            tables,
            pages,
          )) {
            owners.add(ownerId);
          }
        }
        ownerIds = [...owners];
      }
      for (const ownerId of ownerIds) {
        addWork(entry, ownerId, {
          referenced: { table: table.name, overlay: referencedOverlay },
        });
      }
    }
  }

  for (const work of jobs.values()) {
    await revalidatePublishedOwner(db, session, tables, trx, work.entry, work.ownerId, {
      ...(work.overlay ? { overlay: work.overlay } : {}),
      ...(work.referenced ? { referenced: work.referenced } : {}),
    });
  }
}
