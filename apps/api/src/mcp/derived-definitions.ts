// SPDX-License-Identifier: BUSL-1.1
/**
 * Derived tool definitions per session. Split out of server-scope.ts,
 * verbatim.
 */
import type { RuntimeDeclarativeServiceRequest } from "@openshapeforge/plugin-runtime";
import { sql, type Transaction } from "kysely";
import type { DB } from "../generated/db/types.js";
import { withDbSession } from "../db/session.js";
import {
  derivedToolsFromRows,
  isAuthorizedInternalDerivedRow,
  sessionInAudience,
  type DerivedToolsCatalogEntry,
} from "./derived-tools.js";
import { HttpError } from "../rest/http-error.js";
import { assertUniqueToolNames, type SourcedTool } from "../modules/mcp-hooks.js";
import { type GeneratedTable, catalogDerivedTools } from "./catalog.js";
import { fieldNameForColumn, serializeRow } from "./catalog-rows.js";
import { coreOwnsStaticToolName } from "./session-projection.js";
import { derivedToolsForSession } from "./derived-session-tools.js";
import { runtimeRowByFilter } from "./session-connections.js";
import type { ServerScopePrologue } from "./server-scope.js";

/**
 * How a derived tool's defining row is found and read for one session: the
 * snapshot reads of definition tables, the module-name collision guard, and
 * the resolution of a listed derived name (or a compatibility Operation) to
 * its row.
 */
export function createDerivedDefinitionResolution(base: ServerScopePrologue) {
  const {
    db,
    locale,
    operationToolProjection,
    session,
    tables,
  } = base;
  const definitionFor = (
    entry: DerivedToolsCatalogEntry,
    row: Record<string, unknown>,
  ) => {
    const id = row.id;
    const version = entry.versionField
      ? row[entry.versionField]
      : undefined;
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      !Number.isInteger(version) ||
      (version as number) < 1
    ) {
      throw new HttpError(
        404,
        "NOT_FOUND",
        "Invocation source is unavailable.",
      );
    }
    return {
      kind: entry.entity,
      id,
      version: version as number,
    };
  };

  const columnForField = (table: GeneratedTable, field: string) =>
    table.columns.find((column) => fieldNameForColumn(column) === field);

  const snapshotRowsByFilter = async (
    trx: Transaction<DB>,
    tableName: string,
    filter: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> => {
    const table = tables.get(tableName);
    if (!table) return [];
    const predicates = Object.entries(filter).map(([field, value]) => {
      const column = columnForField(table, field);
      return column
        ? sql`${sql.id(column.name)}::text = ${String(value)}`
        : undefined;
    });
    if (predicates.some((predicate) => predicate === undefined)) return [];
    const where = predicates.length
      ? sql`where ${sql.join(predicates as NonNullable<(typeof predicates)[number]>[], sql` and `)}`
      : sql``;
    const result = await sql<{ row: Record<string, unknown> }>`
      select to_jsonb(row_source.*) as row
        from ${sql.id(table.schema, table.table)} as row_source
        ${where}
    `.execute(trx);
    return result.rows.map(({ row }) => serializeRow(table, row));
  };

  const snapshotDefinitionsByToolName = async (
    trx: Transaction<DB>,
    entry: DerivedToolsCatalogEntry,
    toolName: string,
  ): Promise<Record<string, unknown>[]> => {
    const table = tables.get(entry.table);
    const keyColumn = table ? columnForField(table, entry.keyField) : undefined;
    if (!table || !keyColumn) return [];
    const result = await sql<{ row: Record<string, unknown> }>`
      select to_jsonb(row_source.*) as row
        from ${sql.id(table.schema, table.table)} as row_source
       where lower(replace(btrim(${sql.id(keyColumn.name)}::text), '-', '_')) = ${toolName}
       order by ${sql.id(table.primaryKey ?? keyColumn.name)}
       limit 2
    `.execute(trx);
    return result.rows.map(({ row }) => serializeRow(table, row));
  };

  const coreOwnsDerivedToolName = async (toolName: string): Promise<boolean> => {
    if (coreOwnsStaticToolName(toolName, operationToolProjection)) return true;
    if (!session.tenantId || catalogDerivedTools.length === 0) return false;
    return withDbSession(db, session, async (trx) => {
      for (const entry of catalogDerivedTools) {
        if ((await snapshotDefinitionsByToolName(trx, entry, toolName)).length > 0) {
          return true;
        }
      }
      return false;
    });
  };

  const assertModuleToolNamesAvailable = async (
    tools: readonly SourcedTool[],
  ): Promise<void> => {
    assertUniqueToolNames(tools);
    for (const { tool } of tools) {
      if (coreOwnsStaticToolName(tool.name, operationToolProjection)) {
        throw new Error(
          `MCP tool name ${JSON.stringify(tool.name)} is contributed more than once.`,
        );
      }
    }
    if (!session.tenantId || catalogDerivedTools.length === 0 || tools.length === 0) {
      return;
    }
    await withDbSession(db, session, async (trx) => {
      for (const { tool } of tools) {
        for (const entry of catalogDerivedTools) {
          if (
            (await snapshotDefinitionsByToolName(trx, entry, tool.name)).length >
            0
          ) {
            throw new Error(
              `MCP tool name ${JSON.stringify(tool.name)} is contributed more than once.`,
            );
          }
        }
      }
    });
  };

  const derivedDefinition = async (
    toolName: string,
    projectedOnly: boolean,
  ): Promise<
    | {
        entry: DerivedToolsCatalogEntry;
        row: Record<string, unknown>;
      }
    | undefined
  > => {
    if (projectedOnly) {
      const projected = (await derivedToolsForSession(db, session, tables, locale)).find(
        (tool) => tool.name === toolName,
      );
      if (!projected) return undefined;
      const entry = catalogDerivedTools.find(
        (candidate) => candidate.table === projected.table,
      );
      const row = entry
        ? await runtimeRowByFilter(db, session, tables, entry.table, {
            id: projected.rowId,
          })
        : null;
      return entry && row ? { entry, row } : undefined;
    }
    return withDbSession(db, session, async (trx) => {
      for (const entry of catalogDerivedTools) {
        if (!entry.execution || !sessionInAudience(entry, session.roles))
          continue;
        const rows = await snapshotDefinitionsByToolName(trx, entry, toolName);
        if (rows.length !== 1) continue;
        const row = rows[0]!;
        if (isAuthorizedInternalDerivedRow(entry, row, session.roles)) {
          return { entry, row };
        }
      }
      return undefined;
    });
  };

  /**
   * Re-read one canonical provider definition through generated internal
   * compatibility metadata. This deliberately does not project the row as an
   * MCP tool; the runtime Operation provider owns public listing and lookup.
   */
  const compatibilityDefinition = async (
    request: RuntimeDeclarativeServiceRequest,
  ): Promise<
    | { entry: DerivedToolsCatalogEntry; row: Record<string, unknown> }
    | undefined
  > => {
    for (const entry of catalogDerivedTools) {
      if (
        !entry.compatibility ||
        entry.entity !== request.definition.entity ||
        !sessionInAudience(entry, session.roles)
      ) continue;
      const row = await runtimeRowByFilter(db, session, tables, entry.table, {
        id: request.definition.id,
      });
      if (!row) continue;
      const publiclyAvailable = derivedToolsFromRows(
        entry,
        [row],
        new Set(),
        session.roles,
        locale,
      ).length === 1;
      if (
        !publiclyAvailable &&
        !isAuthorizedInternalDerivedRow(entry, row, session.roles)
      ) continue;
      return { entry, row };
    }
    return undefined;
  };

  return {
    definitionFor,
    columnForField,
    snapshotRowsByFilter,
    snapshotDefinitionsByToolName,
    coreOwnsDerivedToolName,
    assertModuleToolNamesAvailable,
    derivedDefinition,
    compatibilityDefinition,
  };
}
