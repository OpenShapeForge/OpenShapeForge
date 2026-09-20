// SPDX-License-Identifier: BUSL-1.1
/**
 * The dry-run helper of a derived tool: compose the provider requests
 * without sending them. Split out of the tool dispatch.
 */

/** The dry-run helper of a derived tool: compose the provider requests without sending them. */
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { listGeneratedEntitiesForTable } from "../operations/entity/index.js";
import { deriveToolName, derivedHelperAvailable, derivedToolsFromRows } from "./derived-tools.js";
import { bindingSelected, composeBindingRequest } from "./declarative-execution.js";
import { loadOrderedBindings } from "./execution-bindings.js";
import { HttpError, toHttpError } from "../rest/http-error.js";
import { catalog, catalogDerivedTools, entityForTable } from "./catalog.js";
import { connectionScopeOf, serializeRow } from "./catalog-rows.js";
import { DERIVED_TOOLS_ROW_LIMIT } from "./derived-session-tools.js";
import { requireArguments } from "./entity-tool-guards.js";
import {
  normalizeConnectionValueRows,
  runtimeBindingReader,
  runtimeRowByFilter,
  runtimeRowsByFilter,
  urlSafeConnectionValues,
} from "./session-connections.js";
import { type DirectCallScope } from "./tool-dispatch.js";
import { failed, ok } from "./tool-results.js";
import { assertSchemaValid } from "./tool-schema.js";
export async function dryRunToolCall(
  ctx: DirectCallScope,
): Promise<CallToolResult | undefined> {
  const {
    db,
    locale,
    name,
    request,
    session,
    tables,
  } = ctx;
  const dryRunEntry = catalogDerivedTools.find(
    (entry) => entry.dryRun?.name === name,
  );
  if (dryRunEntry) {
    // The listing's rule (derivedHelperAvailable): audience AND the dry-run roles.
    if (!derivedHelperAvailable(dryRunEntry, "dryRun", session.roles) || !dryRunEntry.execution) {
      return failed(
        new HttpError(404, "NOT_FOUND", `Unknown tool "${name}".`),
      );
    }
    try {
      const execution = dryRunEntry.execution;
      const args = requireArguments(request.params.arguments);
      const toolArg = args.tool;
      if (typeof toolArg !== "string" || toolArg.length === 0) {
        throw new HttpError(
          400,
          "VALIDATION",
          'Argument "tool" is required.',
        );
      }
      const toolArguments =
        args.arguments &&
        typeof args.arguments === "object" &&
        !Array.isArray(args.arguments)
          ? (args.arguments as Record<string, unknown>)
          : {};

      // Deliberately ungated by visibleWhen: previewing a DRAFT before
      // publishing it is the point of a dry run. The caller's roles gate
      // the tool itself.
      const table = tables.get(dryRunEntry.table);
      if (!table)
        throw new HttpError(404, "NOT_FOUND", `Unknown tool "${toolArg}".`);
      const rows = (
        await listGeneratedEntitiesForTable(db, session, table, {
          limit: DERIVED_TOOLS_ROW_LIMIT,
        })
      ).rows.map((row) => serializeRow(table, row));
      const { visibleWhen: _gate, ...ungated } = dryRunEntry;
      // Accept the defining row's key as well as the derived tool name.
      const wantedName = deriveToolName(toolArg) ?? toolArg;
      const target = derivedToolsFromRows(
        ungated,
        rows,
        new Set(catalog.tools.map((tool) => tool.name)),
        session.roles ?? [],
        locale,
      ).find((tool) => tool.name === wantedName);
      const definitionRow = target
        ? rows.find((row) => String(row.id ?? "") === target.rowId)
        : undefined;
      if (!target || !definitionRow) {
        throw new HttpError(
          404,
          "NOT_FOUND",
          `No definition provides the tool "${toolArg}".`,
        );
      }
      assertSchemaValid(target.inputSchema, toolArguments, "arguments");

      const requests: Record<string, unknown>[] = [];
      const bindings = await loadOrderedBindings(
        execution,
        definitionRow,
        runtimeBindingReader(db, session, tables),
      );
      for (const [index, binding] of bindings.entries()) {
        // Selection is part of what a dry run verifies: show WHICH bindings
        // the given arguments route to, and say why the others sit out.
        if (
          !bindingSelected(binding, toolArguments as Record<string, unknown>)
        ) {
          const when = binding.when as Record<string, unknown>;
          const condition =
            when?.present === true
              ? `${String(when.field)} has a value.`
              : `${String(when?.field)} is ${JSON.stringify(when?.equals)} or omitted.`;
          requests.push({
            order: index + 1,
            skipped: `Not selected by this call: it runs only when ${condition}`,
          });
          continue;
        }
        const notes: string[] = [];
        if (index > 0) {
          notes.push(
            "Values produced by earlier bindings join these inputs at run time; " +
              "placeholders they would resolve may be reported as unresolved here.",
          );
        }
        const operationId = binding[execution.operationRef];
        const operationRow =
          typeof operationId === "string"
            ? await runtimeRowByFilter(
                db,
                session,
                tables,
                execution.operationTable,
                {
                  id: operationId,
                },
              )
            : null;
        if (!operationRow) {
          requests.push({
            order: index + 1,
            problem: `The binding references a missing ${execution.operationEntity}.`,
          });
          continue;
        }
        const providerId = operationRow[execution.providerRef];
        const providerRow =
          typeof providerId === "string"
            ? await runtimeRowByFilter(
                db,
                session,
                tables,
                execution.providerTable,
                {
                  id: providerId,
                },
              )
            : null;
        if (!providerRow) {
          requests.push({
            order: index + 1,
            operation: operationRow.key,
            problem: `The ${execution.operationEntity} references a missing ${execution.providerEntity}.`,
          });
          continue;
        }
        const connectionRows = normalizeConnectionValueRows(
          await runtimeRowsByFilter(
            db,
            session,
            tables,
            execution.connectionTable,
            { [execution.connectionProviderRef]: providerId },
          ),
          execution.connectionValuesField,
        );
        const tenantConnection = connectionRows.find(
          (row) => !row.ownerUserId,
        );
        if (!tenantConnection) {
          notes.push(
            `No ${execution.connectionEntity} is configured for this ` +
              `${execution.providerEntity}; values it would provide are unresolved.`,
          );
        }
        // Composition resolves URL templates from the tenant row's URL-safe
        // values — plain ones plus encrypted ones whose field is not
        // classified secret; placeholder auth needs no secrets at all.
        const dryRunElicit = entityForTable(
          execution.connectionTable,
        )?.elicitOnCreate;
        const connectionValues = urlSafeConnectionValues(
          tenantConnection,
          execution.connectionValuesField,
          providerRow[dryRunElicit?.definitionsField ?? ""],
          dryRunElicit?.sourceTable ?? execution.providerTable,
        ).plain;
        const providerAuth = (providerRow.auth ?? null) as Record<
          string,
          unknown
        > | null;
        let providerForCompose = providerRow;
        if (providerAuth?.profile === "oauth2AuthorizationCode") {
          providerForCompose = {
            ...providerRow,
            auth: { scheme: "bearer", tokenFrom: "accessToken" },
          };
          notes.push(
            connectionScopeOf(providerAuth) === "both"
              ? "Execution can use an explicitly selected personal or organization sign-in token."
              : connectionScopeOf(providerAuth) === "user"
                ? "Executing uses the caller's personal sign-in token as the bearer value."
                : "Executing uses the tenant sign-in token as the bearer value.",
          );
        }
        try {
          const composed = await composeBindingRequest({
            binding,
            operationRow,
            providerRow: providerForCompose,
            connectionValues,
            serviceInputs: toolArguments,
            secretScope: execution.connectionTable,
            providerDefinitions:
              providerRow[dryRunElicit?.definitionsField ?? ""],
            mode: "describe",
          });
          requests.push({
            order: index + 1,
            operation: operationRow.key,
            method: composed.method,
            url: composed.url.toString(),
            headers: composed.headers,
            ...(composed.body !== undefined
              ? { body: JSON.parse(composed.body) }
              : {}),
            ...(notes.length > 0 ? { notes } : {}),
          });
        } catch (error) {
          const { body } = toHttpError(error);
          requests.push({
            order: index + 1,
            operation: operationRow.key,
            problem: body.error.message,
            ...(notes.length > 0 ? { notes } : {}),
          });
        }
      }
      return ok({
        tool: toolArg,
        definition: definitionRow.key,
        sent: false,
        requests,
      });
    } catch (error) {
      return failed(error);
    }
  }
  return undefined;
}
