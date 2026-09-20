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
import { validateVisibleDefinition } from "./publication-validation.js";
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

