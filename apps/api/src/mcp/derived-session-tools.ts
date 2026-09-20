// SPDX-License-Identifier: BUSL-1.1
/**
 * The row-defined (derived) tools a session sees: Service rows of the
 * deployment projected into MCP tools, gated on audience and publication
 * rather than on the defining entities' CRUD roles.
 *
 * Split out of generated-mcp-server.ts.
 */
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DbSessionInput } from "../db/session.js";
import { listGeneratedEntitiesForTable } from "../operations/entity/index.js";
import {
  applyPersonalNotes,
  derivedToolsFromRows,
  sessionInAudience,
  type DerivedTool,
  type DerivedToolsCatalogEntry,
} from "./derived-tools.js";
import { definitionFieldKeys, secretFieldKeys } from "./declarative-execution.js";
import { connectionNeedsOf, describeConnectionNeeds, withConnectionNeeds } from "./connection-guidance.js";
import { type ResolvedLocale } from "./locale.js";
import {
  catalog,
  catalogDerivedTools,
  entityForTable,
  serializeRow,
  type GeneratedTable,
} from "./catalog.js";
import { connectionToolsFor, providerDisplayName } from "./session-connections.js";

/**
 * Cap on rows a definition table contributes to the derived-tool projection.
 * A deployment authoring more definitions than this needs curation, not a
 * longer tool list — tool selection quality degrades well before the cap.
 */
export const DERIVED_TOOLS_ROW_LIMIT = 100;

export function derivedToolOutputFieldAllowlist(
  entry: DerivedToolsCatalogEntry,
  row: Record<string, unknown>,
): readonly string[] | undefined {
  if (!entry.outputFieldsField) return undefined;
  const definitions = row[entry.outputFieldsField];
  const withheld = secretFieldKeys(definitions);
  return [...definitionFieldKeys(definitions)]
    .filter((field) => !withheld.has(field))
    .sort();
}

/**
 * The per-session derived tools: definition rows read tenant-scoped (but
 * deliberately outside the entity-role gate — see
 * listGeneratedEntitiesForTable) for every projection whose audience roles
 * admit the session. Static catalog names are reserved so a stored
 * definition can never shadow a product tool.
 */
export async function derivedToolsForSession(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  tables: Map<string, GeneratedTable>,
  /** The language the projected titles and field labels are shown in. */
  locale?: ResolvedLocale,
): Promise<DerivedTool[]> {
  const reserved = new Set(catalog.tools.map((tool) => tool.name));
  const tools: DerivedTool[] = [];
  for (const entry of catalogDerivedTools) {
    if (entry.compatibility) continue;
    if (!sessionInAudience(entry, session.roles)) continue;
    const table = tables.get(entry.table);
    if (!table) continue;
    const result = await listGeneratedEntitiesForTable(db, session, table, {
      limit: DERIVED_TOOLS_ROW_LIMIT,
    });
    const rows = result.rows.map((row) => serializeRow(table, row));
    let entryTools = derivedToolsFromRows(
      entry,
      rows,
      reserved,
      session.roles ?? [],
      locale,
    );
    // Honest annotations, derived from the chain instead of assumed: a tool
    // whose every bound operation is a query is read-only, and hosts treat
    // read-only tools with less approval friction. A chain that does not
    // resolve keeps the cautious default.
    if (entry.execution && entryTools.length > 0) {
      const operationTable = tables.get(entry.execution.operationTable);
      if (operationTable) {
        const operationRows = await listGeneratedEntitiesForTable(
          db,
          session,
          operationTable,
          {
            limit: DERIVED_TOOLS_ROW_LIMIT,
          },
        );
        const operationTraits = new Map<
          string,
          { mutation: boolean; destructive: boolean; providerId: string }
        >();
        for (const raw of operationRows.rows) {
          const row = serializeRow(operationTable, raw);
          const operation = (row.operation ?? {}) as Record<string, unknown>;
          operationTraits.set(String(row.id), {
            mutation: row.kind === "mutation",
            destructive:
              typeof operation.method === "string" &&
              operation.method.toUpperCase() === "DELETE",
            providerId: String(row[entry.execution.providerRef] ?? ""),
          });
        }
        // What each provider needs from the organization and the person,
        // read from the Adapter rows (auth block and configuration contract)
        // so the generated sentence can never disagree with execution.
        const providerNeeds = new Map<string, string>();
        const providerTable = tables.get(entry.execution.providerTable);
        if (providerTable) {
          const providerRows = await listGeneratedEntitiesForTable(
            db,
            session,
            providerTable,
            { limit: DERIVED_TOOLS_ROW_LIMIT },
          );
          const definitionsField =
            entityForTable(entry.execution.connectionTable)?.elicitOnCreate
              ?.definitionsField ?? "";
          const toolNames = connectionToolsFor(entry.execution, entry);
          for (const raw of providerRows.rows) {
            const row = serializeRow(providerTable, raw);
            providerNeeds.set(
              String(row.id),
              describeConnectionNeeds(
                providerDisplayName(row, entry.execution),
                connectionNeedsOf(row.auth, row[definitionsField]),
                toolNames,
              ),
            );
          }
        }
        const rowById = new Map(rows.map((row) => [String(row.id), row]));
        entryTools = entryTools.map((tool) => {
          const bindingsRaw = rowById.get(tool.rowId)?.[
            entry.execution!.bindingsField
          ];
          const bindings = Array.isArray(bindingsRaw)
            ? (bindingsRaw as Record<string, unknown>[])
            : [];
          let mutation = false;
          let destructive = false;
          let resolved = bindings.length > 0;
          const needs: string[] = [];
          for (const binding of bindings) {
            const traits = operationTraits.get(
              String(binding?.[entry.execution!.operationRef] ?? ""),
            );
            if (!traits) {
              resolved = false;
              continue;
            }
            mutation ||= traits.mutation;
            destructive ||= traits.destructive;
            const sentence = providerNeeds.get(traits.providerId);
            if (sentence && !needs.includes(sentence)) needs.push(sentence);
          }
          return {
            ...tool,
            description: withConnectionNeeds(tool.description, needs.join(" ")),
            readOnly: resolved && !mutation,
            destructive,
          };
        });
      }
    }
    // The caller's stored standing instructions ride along on THEIR view of
    // the tools — appended under the authored description, never over it.
    if (entry.personalization && entryTools.length > 0) {
      const preferenceTable = tables.get(entry.personalization.table);
      if (preferenceTable) {
        const mine = await listGeneratedEntitiesForTable(
          db,
          session,
          preferenceTable,
          {
            limit: 100,
            fixedWhere: [{ column: "owner_user_id", value: session.userId }],
          },
        );
        entryTools = applyPersonalNotes(
          entryTools,
          entry,
          mine.rows.map((row) => serializeRow(preferenceTable, row)),
        );
      }
    }
    for (const tool of entryTools) {
      reserved.add(tool.name);
      tools.push(tool);
    }
  }
  return tools;
}
