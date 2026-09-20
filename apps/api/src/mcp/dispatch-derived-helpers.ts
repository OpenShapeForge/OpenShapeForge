// SPDX-License-Identifier: BUSL-1.1
import type { DbSessionInput } from "../db/session.js";
import { withDbSession } from "../db/session.js";
import {
  createGeneratedEntityForTable,
  listGeneratedEntitiesForTable,
  updateGeneratedEntityForTable,
} from "../operations/entity/index.js";
import { deriveToolName, derivedToolsFromRows, sessionInAudience } from "./derived-tools.js";
import {
  bindingSelected,
  composeBindingRequest,
  orderedBindings,
  resolveTemplate,
} from "./declarative-execution.js";
import { mintAuthorization, scopesCovered } from "./entity-oauth.js";
import { accessTokenNeedsRefresh } from "./connection-token-refresh.js";
import { HttpError, toHttpError } from "../rest/http-error.js";
import { missingRequiredConnectionValues } from "./connection-guidance.js";
import { isOrganizationAdministrator } from "./onboarding.js";
import {
  catalog,
  catalogDerivedTools,
  connectionScopeOf,
  entityForTable,
  serializeRow,
} from "./catalog.js";
import { DERIVED_TOOLS_ROW_LIMIT, derivedToolsForSession } from "./derived-session-tools.js";
import { requireArguments } from "./entity-tool-invocation.js";
import { ENTITY_OAUTH_CALLBACK_PATH, callbackOrigin } from "./handoff-config.js";
import {
  looksLikeStoredSecret,
  normalizeConnectionValueRows,
  organizationConnectionProblem,
  readClientCredentials,
  runtimeRowByFilter,
  runtimeRowsByFilter,
  urlSafeConnectionValues,
} from "./session-connections.js";
import { failed, ok } from "./tool-results.js";
import { assertSchemaValid } from "./tool-schema.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DirectCallScope } from "./tool-dispatch.js";

/** The dry-run helper of a derived tool: compose the provider requests without sending them. */
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
    const allowed = dryRunEntry.dryRun!.roles.some((role) =>
      (session.roles ?? []).includes(role),
    );
    if (!allowed || !dryRunEntry.execution) {
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
      const bindings = orderedBindings(
        definitionRow,
        execution.bindingsField,
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

/** The preferences helper of a derived tool: the person's standing instructions. */
export async function personalizationToolCall(
  ctx: DirectCallScope,
): Promise<CallToolResult | undefined> {
  const {
    db,
    locale,
    name,
    onDerivedDefinitionChanged,
    request,
    session,
    tables,
  } = ctx;
  const personalizationEntry = catalogDerivedTools.find(
    (entry) => entry.personalization?.set.name === name,
  );
  if (personalizationEntry) {
    if (
      !sessionInAudience(personalizationEntry, session.roles) ||
      !personalizationEntry.personalization
    ) {
      return failed(
        new HttpError(404, "NOT_FOUND", `Unknown tool "${name}".`),
      );
    }
    try {
      const personalization = personalizationEntry.personalization;
      const args = requireArguments(request.params.arguments);
      const instruction =
        typeof args.instruction === "string" ? args.instruction.trim() : null;
      if (instruction === null) {
        throw new HttpError(
          400,
          "VALIDATION",
          'Argument "instruction" is required; an empty string clears the stored one.',
        );
      }
      if (instruction.length > 500) {
        throw new HttpError(
          400,
          "VALIDATION",
          "Keep the instruction under 500 characters — it rides along on every tool listing.",
        );
      }
      // Optional target tool; absent means the instruction applies to all.
      let serviceRowId: string | null = null;
      let appliesTo = "all tools";
      if (typeof args.tool === "string" && args.tool.length > 0) {
        const wanted = deriveToolName(args.tool) ?? args.tool;
        const projected = (
          await derivedToolsForSession(db, session, tables, locale)
        ).find(
          (tool) =>
            tool.name === wanted && tool.table === personalizationEntry.table,
        );
        if (!projected) {
          throw new HttpError(
            404,
            "NOT_FOUND",
            `No tool "${args.tool}" to set an instruction for.`,
          );
        }
        serviceRowId = projected.rowId;
        appliesTo = wanted;
      }
      const preferenceTable = tables.get(personalization.table);
      if (!preferenceTable) {
        throw new HttpError(
          500,
          "INTERNAL",
          "Preference table is missing from the manifest.",
        );
      }
      // The row is the CALLER's own, bound to them by the runtime — the
      // same ownership model as personal connections.
      const mine = (
        await listGeneratedEntitiesForTable(db, session, preferenceTable, {
          limit: 100,
          fixedWhere: [{ column: "owner_user_id", value: session.userId }],
        })
      ).rows.map((row) => serializeRow(preferenceTable, row));
      const existing = mine.find(
        (row) => (row[personalization.serviceRef] ?? null) === serviceRowId,
      );
      const writeSession: DbSessionInput = {
        tenantId: session.tenantId as string,
        userId: session.userId as string,
        roles: [],
        groups: [],
        scope: "self",
      };
      if (existing) {
        await updateGeneratedEntityForTable(
          db,
          writeSession,
          preferenceTable,
          String(existing.id),
          {
            [personalization.instructionField]: instruction,
          },
        );
      } else if (instruction.length > 0) {
        await createGeneratedEntityForTable(
          db,
          writeSession,
          preferenceTable,
          {
            key: `pref-${String(session.userId)}-${serviceRowId ?? "all"}`.toLowerCase(),
            name: `Personal instruction (${appliesTo})`,
            ownerUserId: session.userId,
            ...(serviceRowId
              ? { [personalization.serviceRef]: serviceRowId }
              : {}),
            [personalization.instructionField]: instruction,
          },
        );
      }
      // Descriptions changed for this person's sessions; nudge them.
      onDerivedDefinitionChanged?.(
        personalizationEntry.table,
        session.tenantId ?? null,
      );
      return ok({
        saved: instruction.length > 0,
        appliesTo,
        message:
          instruction.length > 0
            ? "Saved. Every assistant this person uses sees it alongside the tool from its next listing."
            : "Cleared.",
      });
    } catch (error) {
      return failed(error);
    }
  }
  return undefined;
}

/** The connect helper of a derived tool: a personal or organization sign-in at the provider. */
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
        const providerRowId = signIn.id;

        // Scopes derive from the UNION of every projected definition on this
        // provider, not the entry-point tool alone: the person signs in once
        // per provider, and a consent shaped by one read tool would mint a
        // token every write tool answers 403 with — leaving over-broadening
        // that read tool as the only "fix" (seen live). A sibling row whose
        // chain does not resolve is skipped: publication validation guards
        // new rows, and a broken legacy row must not block sign-in.
        const requiredScopes =
          requiredScopesByProvider.get(providerRowId) ?? new Set<string>();
        const providerRow = signIn.row;
        const auth = signIn.auth;
        const declaredScope = connectionScopeOf(auth);
        const scope_ =
          declaredScope === "both"
            ? requestedConnectionScope === "organization"
              ? "tenant"
              : "user"
            : declaredScope;
        if (
          scope_ === "tenant" &&
          !isOrganizationAdministrator(session.roles)
        ) {
          throw new HttpError(
            403,
            "FORBIDDEN",
            "This shared tenant connection requires an explicitly delegated organization role.",
          );
        }
        const authorizationUrl = auth.authorizationUrl;
        const tokenUrl = auth.tokenUrl;
        if (
          typeof authorizationUrl !== "string" ||
          typeof tokenUrl !== "string"
        ) {
          throw new HttpError(
            400,
            "PROVIDER_MISCONFIGURED",
            "The provider declares no authorization and token endpoints.",
          );
        }
        const adapterScopes = Array.isArray(auth.scopes)
          ? (auth.scopes as unknown[]).filter(
              (scope): scope is string => typeof scope === "string",
            )
          : [];
        const scopes =
          requiredScopes.size > 0
            ? [...requiredScopes].filter(
                (scope) =>
                  adapterScopes.length === 0 || adapterScopes.includes(scope),
              )
            : adapterScopes;
        // An empty intersection is a definition mismatch, not a scopeless
        // provider: authorizing with no scopes would mint a token the tool
        // cannot use (seen live as a provider "invalid scope" page).
        if (requiredScopes.size > 0 && scopes.length === 0) {
          throw new HttpError(
            400,
            "SCOPES_NOT_ALLOWED",
            `This definition requires scopes the ${execution.providerEntity} does not allow: ` +
              `${[...requiredScopes].join(", ")}. Add them to its allowed scopes first.`,
          );
        }

        const connectionRows = normalizeConnectionValueRows(
          await runtimeRowsByFilter(
            db,
            session,
            tables,
            execution.connectionTable,
            { [execution.connectionProviderRef]: providerRowId },
          ),
          execution.connectionValuesField,
        );
        const existingForScope =
          scope_ === "user"
            ? connectionRows.find((row) => row.ownerUserId === session.userId)
            : connectionRows.find((row) => !row.ownerUserId);
        const existingValues = (existingForScope?.[
          execution.connectionValuesField
        ] ?? null) as Record<string, unknown> | null;
        // An existing sign-in only satisfies the request while its granted
        // scopes still cover the definition's CURRENT requirements. When a
        // scope evolved after consent, silently reusing the old token
        // guarantees a provider 403 — the fix is a fresh approval, minted
        // below, whose callback replaces the stored tokens in place.
        const hasExistingTokens = Boolean(
          existingForScope &&
          existingValues?.accessToken &&
          (!accessTokenNeedsRefresh(existingValues) ||
            looksLikeStoredSecret(existingValues.refreshToken)),
        );
        if (
          hasExistingTokens &&
          scopesCovered(scopes, existingValues?.grantedScopes)
        ) {
          connectedProviders.push(String(providerRow.name ?? providerRowId));
          continue;
        }
        const reconsent = hasExistingTokens;
        const tenantConnection = connectionRows.find(
          (row) => !row.ownerUserId,
        );
        const secretScope =
          entityForTable(execution.connectionTable)?.elicitOnCreate
            ?.sourceTable ?? execution.providerTable;
        let credentials: ReturnType<typeof readClientCredentials>;
        try {
          credentials = readClientCredentials(
            tenantConnection,
            execution.connectionValuesField,
            secretScope,
          );
        } catch (error) {
          if (error instanceof HttpError && error.code === "CONNECTION_MISSING") {
            throw await organizationConnectionProblem({
              db,
              session,
              tables,
              execution,
              entry: connectEntry,
              providerRow,
              ...(tenantConnection
                ? {
                    missingValues: missingRequiredConnectionValues(
                      providerRow[
                        entityForTable(execution.connectionTable)?.elicitOnCreate
                          ?.definitionsField ?? ""
                      ],
                      auth,
                      tenantConnection[execution.connectionValuesField],
                    ),
                  }
                : {}),
            });
          }
          throw error;
        }

        // Provider OAuth endpoints are routinely per-tenant
        // (https://{subdomain}.provider.com/...): placeholders resolve from
        // the tenant connection's NON-secret values, like base URLs do —
        // including encrypted-at-rest values whose field is not classified
        // secret. A placeholder that reaches for a secret-classified field
        // fails with the classification named, not as a data-entry gap.
        const tenantUrlValues = urlSafeConnectionValues(
          tenantConnection,
          execution.connectionValuesField,
          providerRow[
            entityForTable(execution.connectionTable)?.elicitOnCreate
              ?.definitionsField ?? ""
          ],
          secretScope,
        );
        const resolvedAuthorizationUrl = resolveTemplate(
          authorizationUrl,
          tenantUrlValues.plain,
          "auth.authorizationUrl",
          tenantUrlValues.secretKeys,
        );
        const resolvedTokenUrl = resolveTemplate(
          tokenUrl,
          tenantUrlValues.plain,
          "auth.tokenUrl",
          tenantUrlValues.secretKeys,
        );

        const handoff = await mintAuthorization({
          db,
          tenantId: session.tenantId as string,
          userId: session.userId as string,
          providerTable: execution.providerTable,
          providerRowId,
          connectionTable: execution.connectionTable,
          connectionProviderRef: execution.connectionProviderRef,
          connectionValuesField: execution.connectionValuesField,
          tokenUrl: resolvedTokenUrl,
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
          egress: Array.isArray(providerRow.egressHosts)
            ? (providerRow.egressHosts as string[])
            : [],
          scopes,
          redirectUri: `${callbackOrigin()}${ENTITY_OAUTH_CALLBACK_PATH}`,
          providerName: String(providerRow.name ?? providerRowId),
          connectionScope: scope_,
          authorizationUrl: resolvedAuthorizationUrl,
        });
        return ok({
          action: "authorize",
          provider: String(providerRow.name ?? providerRowId),
          ...(signInProviders.length > 1
            ? {
                providerProgress: `${providerIndex + 1} of ${signInProviders.length}`,
              }
            : {}),
          scopes,
          authorizationUrl: handoff.authorizationUrl,
          expiresInSeconds: handoff.expiresInSeconds,
          instructions:
            (reconsent
              ? "The required permissions changed since this connection was approved; a " +
                "fresh approval replaces the stored sign-in in place. "
              : "") +
            (signInProviders.length > 1
              ? "This definition spans multiple providers; each is connected in turn. "
              : "") +
            "Ask the person to open authorizationUrl in their browser and approve access. " +
            "Then wait by checking, not by asking: call this tool again every ten seconds " +
            "or so (sleep between checks if you can) — it continues with the next provider " +
            "or answers connected once every sign-in has landed. Only if nothing has " +
            "landed after about three minutes, ask the person to tell you when they are " +
            "done.",
        });
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
