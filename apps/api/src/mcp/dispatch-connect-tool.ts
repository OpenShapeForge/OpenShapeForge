// SPDX-License-Identifier: BUSL-1.1
/**
 * The connect helper of a derived tool: a personal or organization sign-in
 * at the provider. Split out of the tool dispatch.
 */

/** The connect helper of a derived tool: a personal or organization sign-in at the provider. */
import { connectProviderStep } from "./dispatch-connect-provider.js";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { withDbSession } from "../db/session.js";
import { listGeneratedEntitiesForTable } from "../operations/entity/index.js";
import { deriveToolName, derivedToolsFromRows, sessionInAudience } from "./derived-tools.js";
import { orderedBindings } from "./declarative-execution.js";
import { HttpError } from "../rest/http-error.js";
import { catalogDerivedTools } from "./catalog.js";
import { serializeRow } from "./catalog-rows.js";
import { DERIVED_TOOLS_ROW_LIMIT } from "./derived-session-tools.js";
import { runtimeRowByFilter } from "./session-connections.js";
import { type DirectCallScope } from "./tool-dispatch.js";
import { failed, ok } from "./tool-results.js";
export async function connectToolCall(
  ctx: DirectCallScope,
): Promise<CallToolResult | undefined> {
  const {
    db,
    locale,
    name,
    request,
    session,
    snapshotDefinitionsByToolName,
    tables,
  } = ctx;
  const connectEntry = catalogDerivedTools.find(
    (entry) => entry.connect?.name === name,
  );
  if (connectEntry) {
    if (
      !sessionInAudience(connectEntry, session.roles) ||
      !connectEntry.execution
    ) {
      return failed(
        new HttpError(404, "NOT_FOUND", `Unknown tool "${name}".`),
      );
    }
    try {
      const execution = connectEntry.execution;
      const toolArg = (
        request.params.arguments as Record<string, unknown> | undefined
      )?.tool;
      const requestedConnectionScope = (
        request.params.arguments as Record<string, unknown> | undefined
      )?.connectionScope;
      if (typeof toolArg !== "string" || toolArg.length === 0) {
        throw new HttpError(
          400,
          "VALIDATION",
          'Argument "tool" is required.',
        );
      }
      // Only a row the session could call can start a connection: the
      // same publication and audience rules the projection applies, so an
      // unpublished or invisible definition answers exactly like a
      // nonexistent one. Resolved by key snapshot rather than through
      // derivedToolsForSession, which leaves compatibility entries — the
      // ones the Operation runtime lists and executes — out on purpose;
      // going through it made every personal sign-in on such a deployment
      // answer NOT_FOUND for a tool the person had just called. Callers
      // often hold the defining row's KEY rather than the derived name, so
      // the input is normalized through the same derivation.
      const wantedName = deriveToolName(toolArg) ?? toolArg;
      const candidates = await withDbSession(db, session, (trx) =>
        snapshotDefinitionsByToolName(trx, connectEntry, wantedName),
      );
      const definitionRow =
        candidates.length === 1 &&
        derivedToolsFromRows(
          connectEntry,
          candidates,
          new Set<string>(),
          session.roles ?? [],
          locale,
        ).some((tool) => tool.name === wantedName)
          ? candidates[0]!
          : undefined;
      if (!definitionRow)
        throw new HttpError(
          404,
          "NOT_FOUND",
          `No connectable tool "${toolArg}".`,
        );

      // The provider derives from the target's exact chain; the caller
      // chooses nothing. Exactly one distinct provider per connection.
      const providerIds = new Set<string>();
      for (const binding of orderedBindings(
        definitionRow,
        execution.bindingsField,
      )) {
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
          throw new HttpError(
            400,
            "SERVICE_MISCONFIGURED",
            `A binding references a missing ${execution.operationEntity}.`,
          );
        }
        if (typeof operationRow[execution.providerRef] === "string") {
          providerIds.add(operationRow[execution.providerRef] as string);
        }
      }
      if (providerIds.size === 0) {
        throw new HttpError(
          400,
          "NOT_CONNECTABLE",
          "This definition names no provider.",
        );
      }
      // A canonical definition may span providers; the person connects
      // them ONE AT A TIME through this same tool — each pass mints the
      // consent for the first provider still missing a usable sign-in,
      // and a call with everything in place answers connected. Providers
      // on shared tenant credentials need no personal sign-in and are
      // skipped.
      const signInProviders: {
        id: string;
        row: Record<string, unknown>;
        auth: Record<string, unknown>;
      }[] = [];
      for (const candidateId of providerIds) {
        const candidateRow = await runtimeRowByFilter(
          db,
          session,
          tables,
          execution.providerTable,
          { id: candidateId },
        );
        const candidateAuth = (candidateRow?.auth ?? null) as Record<
          string,
          unknown
        > | null;
        if (
          candidateRow &&
          candidateAuth?.profile === "oauth2AuthorizationCode"
        ) {
          signInProviders.push({
            id: candidateId,
            row: candidateRow,
            auth: candidateAuth,
          });
        }
      }
      if (signInProviders.length === 0) {
        throw new HttpError(
          400,
          "NOT_CONNECTABLE",
          "This definition's provider does not support sign-in connections.",
        );
      }

      // Resolve every definition the session may call once — the same
      // rows the projection would list, read directly so compatibility
      // entries count too — then reuse the per-provider scope union
      // below. Keeping this outside the provider loop avoids a
      // providers × definitions × bindings query multiplier on connect.
      const requiredScopesByProvider = new Map<string, Set<string>>();
      const definitionTable = tables.get(connectEntry.table);
      const callableRows: Record<string, unknown>[] = [];
      if (definitionTable) {
        const allRows = (
          await listGeneratedEntitiesForTable(db, session, definitionTable, {
            limit: DERIVED_TOOLS_ROW_LIMIT,
          })
        ).rows.map((row) => serializeRow(definitionTable, row));
        const rowsById = new Map(allRows.map((row) => [String(row.id), row]));
        for (const tool of derivedToolsFromRows(
          connectEntry,
          allRows,
          new Set<string>(),
          session.roles ?? [],
          locale,
        )) {
          const row = rowsById.get(tool.rowId);
          if (row) callableRows.push(row);
        }
      }
      for (const row of callableRows) {
        try {
          const rowProviders = new Set<string>();
          const rowScopes: string[] = [];
          for (const binding of orderedBindings(
            row,
            execution.bindingsField,
          )) {
            const operationId = binding[execution.operationRef];
            const operationRow =
              typeof operationId === "string"
                ? await runtimeRowByFilter(
                    db,
                    session,
                    tables,
                    execution.operationTable,
                    { id: operationId },
                  )
                : null;
            if (!operationRow) throw new Error("unresolved binding");
            const providerId = operationRow[execution.providerRef];
            if (typeof providerId === "string") rowProviders.add(providerId);
            if (Array.isArray(operationRow.requiredScopes)) {
              for (const scope of operationRow.requiredScopes as unknown[]) {
                if (typeof scope === "string") rowScopes.push(scope);
              }
            }
          }
          if (rowProviders.size !== 1) continue;
          const [providerId] = rowProviders;
          if (!providerId) continue;
          const providerScopes =
            requiredScopesByProvider.get(providerId) ?? new Set<string>();
          for (const scope of rowScopes) providerScopes.add(scope);
          requiredScopesByProvider.set(providerId, providerScopes);
        } catch {
          // A malformed sibling definition cannot block this sign-in.
        }
      }

      const connectedProviders: string[] = [];
      for (const [providerIndex, signIn] of signInProviders.entries()) {
        const outcome = await connectProviderStep(
          {
            ...ctx,
            connectEntry,
            execution,
            requestedConnectionScope,
            requiredScopesByProvider,
            signInProviders,
            connectedProviders,
          },
          providerIndex,
          signIn,
        );
        if (outcome !== undefined) return outcome;
      }
      return ok({
        connected: true,
        providers: connectedProviders,
        message:
          connectedProviders.length > 1
            ? "All providers for this tool are signed in. Just call the tool."
            : "Your personal connection already exists. Just call the tool.",
      });
    } catch (error) {
      return failed(error);
    }
  }
  return undefined;
}
