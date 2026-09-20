// SPDX-License-Identifier: BUSL-1.1
/**
 * The checks an entity tool call passes before the CRUD core sees it:
 * argument shape, declared properties, the fields only an Operation may
 * write, classified fields the caller could not read back, and the
 * publication rule for a definition row. Split out of entity-tool-invocation.ts.
 */

import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DbSessionInput } from "../db/session.js";
import {
  isOperationWrittenColumn,
  operationWrittenRefusal,
  getGeneratedEntity,
} from "../operations/entity/index.js";
import {
  validateVisibleDefinition,
  type PublicationRowReader,
} from "./publication-validation.js";
import {
  BindingOverflowError,
  MAX_BINDINGS_PER_OWNER,
  readAllRelationRows,
  type BindingRowReader,
} from "./execution-bindings.js";
import type { DerivedToolsCatalogEntry } from "./derived-tools.js";
import type { ExecutionCatalogEntry } from "./declarative-execution.js";
import { canReadClassifiedColumns } from "../graphql/generated-authz.js";
import { HttpError } from "../rest/http-error.js";
import { fieldNameForColumn, serializeRow } from "./catalog-rows.js";
import {
  type CatalogEntity,
  type GeneratedTable,
  catalog,
  catalogDerivedTools,
  catalogDiscoveryTools,
  catalogGuideTools,
  catalogTestTools,
  entityForTable,
} from "./catalog.js";
import { runtimeBindingReader, runtimeRowsByFilter } from "./session-connections.js";
export function requireArguments(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new HttpError(
      400,
      "BAD_USER_INPUT",
      "Tool arguments must be an object.",
    );
  }
  return args as Record<string, unknown>;
}

/**
 * Reject arguments the tool's own schema does not declare.
 *
 * The CRUD layer already drops non-writable keys, so this is not a privilege
 * check — it is honesty. Every tool schema carries
 * `additionalProperties: false`, and accepting additional properties anyway
 * makes the catalog lie to the one consumer that reads it: a model that sets
 * `id` believes it created that id, gets a different one, and builds its next
 * step on a false premise. A typo'd field name looks like a successful write of
 * a value that was never stored. REST refuses the same body for the same
 * reason (`assertWritableBody`).
 *
 * Validated against the ADVERTISED schema rather than a second list, so the
 * check and the advertisement cannot drift apart.
 */
export function assertDeclaredProperties(
  schema: Record<string, unknown> | undefined,
  values: Record<string, unknown>,
  what: string,
): void {
  const properties = schema?.properties;
  if (!properties || typeof properties !== "object") return;
  const declared = new Set(Object.keys(properties as Record<string, unknown>));
  const unknown = Object.keys(values).filter((key) => !declared.has(key));
  if (unknown.length > 0) {
    throw new HttpError(
      400,
      "BAD_USER_INPUT",
      `Unknown or non-writable ${what}: ${unknown.sort().join(", ")}. ` +
        `Accepted: ${[...declared].sort().join(", ") || "(none)"}.`,
    );
  }
}

/**
 * A field authored `writtenBy: [...]` is absent from the tool schema, so
 * assertDeclaredProperties below would already refuse it — as "unknown or
 * non-writable", which sends a model looking for a spelling mistake. Run this
 * first so it hears the actual reason and the operation to call instead. The
 * generated CRUD layer refuses it a second time; that is the backstop for any
 * path that does not come through here.
 */
export function assertOperationWrittenFields(
  values: Record<string, unknown>,
  table: GeneratedTable | undefined,
): void {
  for (const column of table?.columns ?? []) {
    if (!isOperationWrittenColumn(column)) continue;
    const field = fieldNameForColumn(column);
    if (!Object.prototype.hasOwnProperty.call(values, field)) continue;
    throw new HttpError(
      400,
      "BAD_USER_INPUT",
      operationWrittenRefusal(field, column.writtenBy!),
    );
  }
}

export function requireId(args: Record<string, unknown>): string {
  const id = args.id;
  if (typeof id !== "string" || id === "") {
    throw new HttpError(
      400,
      "BAD_USER_INPUT",
      "Tool argument `id` is required.",
    );
  }
  return id;
}

/**
 * Reject writes to fields the caller cannot read back. Accepting one would let
 * a read-only caller set a classified value and confirm it through a filter —
 * and would silently succeed at writing data the response then redacts.
 */
export function assertWritableValues(
  values: Record<string, unknown>,
  entity: CatalogEntity | undefined,
  table: GeneratedTable | undefined,
  session: DbSessionInput,
): void {
  if (!entity || entity.classifiedFields.length === 0) return;
  if (canReadClassifiedColumns(table?.source?.authorization, session)) return;
  const offending = Object.keys(values).find((key) =>
    entity.classifiedFields.includes(key),
  );
  if (offending) {
    throw new HttpError(
      403,
      "FORBIDDEN",
      `Not authorized to write classified field "${offending}" on ${entity.entity}.`,
    );
  }
}

/**
 * Guard a create/update that would make a derived-tool definition VISIBLE
 * (`visibleWhen` satisfied on the resulting row): the execution chain and its
 * connections are validated first, so the audience never receives a tool
 * whose first call is a guaranteed misconfiguration failure. Writes that
 * leave the row invisible — drafts, and un-publishing — pass untouched.
 */
export async function assertPublishableWrite(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  tables: Map<string, GeneratedTable>,
  table: GeneratedTable,
  values: Record<string, unknown>,
  rowId?: string,
): Promise<void> {
  const entry = catalogDerivedTools.find(
    (candidate) =>
      candidate.table === table.name &&
      candidate.visibleWhen &&
      candidate.execution,
  );
  if (!entry) return;
  const gate = entry.visibleWhen!;

  let resulting = values;
  if (rowId !== undefined) {
    const current = await getGeneratedEntity(db, session, {
      table: table.name,
      id: rowId,
    });
    if (!current) return; // the update itself will answer NOT_FOUND
    resulting = { ...serializeRow(table, current), ...values };
  }
  if (resulting[gate.field] !== gate.equals) return;

  await validateVisibleDefinition({
    entry,
    row: resulting,
    rowId,
    reservedNames: reservedDerivedToolNames(),
    providerDefinitionsField: entityForTable(entry.execution!.connectionTable)
      ?.elicitOnCreate?.definitionsField,
    readRows: (rowTable, filter) =>
      runtimeRowsByFilter(db, session, tables, rowTable, filter),
    readBindingPages: runtimeBindingReader(db, session, tables),
  });
}

function reservedDerivedToolNames(): Set<string> {
  return new Set<string>([
    ...catalog.tools.map((tool) => tool.name),
    ...catalogDerivedTools.flatMap((candidate) => [
      ...(candidate.connect ? [candidate.connect.name] : []),
      ...(candidate.dryRun ? [candidate.dryRun.name] : []),
      ...(candidate.personalization
        ? [candidate.personalization.set.name]
        : []),
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

/** Reverse catalog: binding-row table → published derived-tool owner entries. */
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

/**
 * Reverse catalog: operation or provider table → owner entries whose
 * published chain would break if that row disappeared.
 */
export function derivedToolEntriesForReferencedTable(
  table: string,
  entries: readonly DerivedToolsCatalogEntry[] = catalogDerivedTools,
): DerivedToolsCatalogEntry[] {
  return entries.filter((entry) => {
    const execution = entry.execution;
    if (!entry.visibleWhen || !execution) return false;
    return (
      execution.operationTable === table || execution.providerTable === table
    );
  });
}

export type BindingRowOverlay =
  | { kind: "create"; row: Record<string, unknown> }
  | { kind: "update"; id: string; before: Record<string, unknown>; after: Record<string, unknown> }
  | { kind: "delete"; id: string; row: Record<string, unknown> };

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
  const parentRef = execution.parentRef ?? "";
  const bindingsTable = execution.bindingsTable ?? "";
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

function hideRowReader(
  readRows: PublicationRowReader,
  table: string,
  id: string,
): PublicationRowReader {
  return async (rowTable, filter) => {
    if (rowTable === table && filter.id === id) return [];
    return readRows(rowTable, filter);
  };
}

async function revalidatePublishedOwner(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  tables: Map<string, GeneratedTable>,
  entry: DerivedToolsCatalogEntry,
  ownerId: string,
  options: {
    overlay?: BindingRowOverlay;
    hide?: { table: string; id: string };
  },
): Promise<void> {
  const ownerTable = tables.get(entry.table);
  if (!ownerTable) return;
  const current = await getGeneratedEntity(db, session, {
    table: entry.table,
    id: ownerId,
  });
  if (!current) return;
  const ownerRow = serializeRow(ownerTable, current);
  if (!isPublishedOwner(entry, ownerRow)) return;
  const readRows: PublicationRowReader = options.hide
    ? hideRowReader(
        (rowTable, filter) =>
          runtimeRowsByFilter(db, session, tables, rowTable, filter),
        options.hide.table,
        options.hide.id,
      )
    : (rowTable, filter) =>
        runtimeRowsByFilter(db, session, tables, rowTable, filter);
  const pages = runtimeBindingReader(db, session, tables);
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
}

/**
 * Revalidate published derived-tool owners affected by a write that is not
 * on the owner table: a binding create/update/delete, or the deletion of a
 * referenced operation or provider. Callers invoke this before the write so
 * a NOT_PUBLISHABLE refusal leaves the stored chain unchanged.
 */
export async function assertPublishableRelatedMutation(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  tables: Map<string, GeneratedTable>,
  table: GeneratedTable,
  mutation:
    | { kind: "create"; values: Record<string, unknown> }
    | { kind: "update"; id: string; values: Record<string, unknown> }
    | { kind: "delete"; id: string },
): Promise<void> {
  const bindingEntries = derivedToolEntriesForBindingTable(table.name);
  if (bindingEntries.length > 0) {
    let overlay: BindingRowOverlay;
    if (mutation.kind === "create") {
      overlay = { kind: "create", row: mutation.values };
    } else {
      const current = await getGeneratedEntity(db, session, {
        table: table.name,
        id: mutation.id,
      });
      if (!current) return;
      const before = serializeRow(table, current);
      if (mutation.kind === "delete") {
        overlay = { kind: "delete", id: mutation.id, row: before };
      } else {
        overlay = {
          kind: "update",
          id: mutation.id,
          before,
          after: { ...before, ...mutation.values },
        };
      }
    }
    for (const entry of bindingEntries) {
      for (const ownerId of bindingOwnerIdsFromOverlay(entry.execution!, overlay)) {
        await revalidatePublishedOwner(db, session, tables, entry, ownerId, {
          overlay,
        });
      }
    }
    return;
  }

  if (mutation.kind !== "delete") return;
  const referenced = derivedToolEntriesForReferencedTable(table.name);
  if (referenced.length === 0) return;
  const pages = runtimeBindingReader(db, session, tables);
  for (const entry of referenced) {
    const gate = entry.visibleWhen!;
    const published: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = await pages(entry.table, { [gate.field]: gate.equals }, {
        limit: 200,
        cursor,
      });
      const body = Array.isArray(page) ? page : page.rows;
      const next = Array.isArray(page) ? null : page.nextCursor;
      published.push(...body);
      if (!next || body.length === 0) break;
      cursor = next;
    }
    for (const owner of published) {
      const ownerId = typeof owner.id === "string" ? owner.id : "";
      if (!ownerId) continue;
      await revalidatePublishedOwner(db, session, tables, entry, ownerId, {
        hide: { table: table.name, id: mutation.id },
      });
    }
  }
}
