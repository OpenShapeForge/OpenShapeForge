// SPDX-License-Identifier: BUSL-1.1
/**
 * Authorized invocation sources of derived tools. Split out of
 * server-scope.ts, verbatim.
 */
import { compareCodeUnits } from "@openshapeforge/operations";
import { withDbSession } from "../db/session.js";
import {
  derivedToolsFromRows,
  isAuthorizedInternalDerivedRow,
  sessionInAudience,
} from "./derived-tools.js";
import { bindingSelected } from "./declarative-execution.js";
import { loadOrderedBindings } from "./execution-bindings.js";
import { scopesCovered } from "./entity-oauth.js";
import { accessTokenNeedsRefresh, refreshLeewaySeconds } from "./connection-token-refresh.js";
import { connectionProblemMessage } from "./connection-guidance.js";
import { isOrganizationAdministrator } from "./onboarding.js";
import {
  type AuthorizedInvocationSource,
  type AuthorizedInvocationSourceResolution,
  type AuthorizedUnavailableInvocationSource,
} from "../modules/invocation-sources.js";
import { mintInvocationSourceReference, sameInvocationSourceReference } from "../modules/source-reference.js";
import {
  type CapturedDerivedExecution,
  catalogDerivedTools,
  entityForTable,
} from "./catalog.js";
import { authorityFingerprint, connectionScopeOf } from "./catalog-rows.js";
import {
  capturePersonalOAuthConnections,
  connectionToolsFor,
  looksLikeStoredSecret,
  normalizeConnectionValueRows,
  providerDisplayName,
} from "./session-connections.js";
import type { ServerScopeBase } from "./server-scope.js";

/**
 * The invocation sources a derived tool may run against, resolved per
 * call: every (binding, provider, connection) the session is authorized for,
 * with the captured rows and the fingerprint that proves the capture, and
 * the lookup of one such source by its reference.
 */
export function createInvocationSourceResolution(base: ServerScopeBase) {
  const {
    db,
    definitionFor,
    locale,
    session,
    snapshotDefinitionsByToolName,
    snapshotRowsByFilter,
  } = base;
  const authorizedSources = async (
    toolName: string,
    projectedOnly: boolean,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AuthorizedInvocationSourceResolution> => {
    signal?.throwIfAborted();
    if (!session.tenantId) return { sources: [], unavailable: [] };
    const tenantId = session.tenantId;
    return withDbSession(db, session, async (trx) => {
      signal?.throwIfAborted();
      for (const entry of catalogDerivedTools) {
        signal?.throwIfAborted();
        const execution = entry.execution;
        if (!execution || !sessionInAudience(entry, session.roles)) continue;
        const rows = await snapshotDefinitionsByToolName(trx, entry, toolName);
        if (rows.length !== 1) continue;
        const serviceRow = rows[0]!;
        const authorized = projectedOnly
          ? derivedToolsFromRows(
              entry,
              [serviceRow],
              new Set<string>(),
              session.roles,
              locale,
            ).some((tool) => tool.name === toolName)
          : isAuthorizedInternalDerivedRow(entry, serviceRow, session.roles);
        if (!authorized) continue;

        const definition = definitionFor(entry, serviceRow);
        const definitionKind = definition.kind;
        const definitionId = definition.id;
        const definitionVersion = definition.version;
        const sources: AuthorizedInvocationSource[] = [];
        const unavailable: AuthorizedUnavailableInvocationSource[] = [];
        const definitionUnavailable = (
          binding: Record<string, unknown>,
          outcome: AuthorizedUnavailableInvocationSource["outcome"],
          guidance?: string,
        ) => unavailable.push({
          tenantId,
          actorId: session.userId,
          toolName,
          binding: Number(binding.order ?? 0),
          definition,
          outcome,
          ...(guidance !== undefined ? { guidance } : {}),
        });
        // The next step for a connection gap on this provider, worded for
        // the caller — the same text the direct execution path raises.
        const connectionGuidance = (
          providerRow: Record<string, unknown>,
          gap: "organization" | "personal" | "tenant_sign_in" | "reauthorization",
        ): string => {
          const adapter = providerDisplayName(providerRow, execution);
          const connectTool = entry.connect?.name ?? null;
          switch (gap) {
            case "organization":
              return connectionProblemMessage({
                kind: "organization_missing",
                adapter,
                adapterId: String(providerRow.id ?? ""),
                createTool: connectionToolsFor(execution, entry).create,
                adapterArgument:
                  entityForTable(execution.connectionTable)?.elicitOnCreate
                    ?.sourceField ?? "adapterId",
                administrator: isOrganizationAdministrator(session.roles),
              });
            case "personal":
              return connectionProblemMessage({
                kind: "personal_missing",
                adapter,
                toolName,
                connectTool,
              });
            case "tenant_sign_in":
              return connectionProblemMessage({
                kind: "tenant_sign_in",
                adapter,
                toolName,
                connectTool,
                administrator: isOrganizationAdministrator(session.roles),
              });
            case "reauthorization":
              return connectionProblemMessage({
                kind: "reauthorization",
                adapter,
                toolName,
                connectTool,
                scope:
                  connectionScopeOf(
                    (providerRow.auth ?? null) as Record<string, unknown> | null,
                  ) === "tenant"
                    ? "tenant"
                    : "user",
                reason: "expired or no longer covers the scopes this tool needs",
              });
          }
        };
        const selectedBindings = (
          await loadOrderedBindings(
            execution,
            serviceRow,
            (table, filter) => snapshotRowsByFilter(trx, table, filter),
          )
        ).filter((binding) => bindingSelected(binding, args));
        for (const binding of selectedBindings) {
          const operationId = binding[execution.operationRef];
          if (typeof operationId !== "string") {
            definitionUnavailable(binding, "unavailable");
            continue;
          }
          const operationRow = (
            await snapshotRowsByFilter(trx, execution.operationTable, {
              id: operationId,
            })
          )[0];
          if (!operationRow) {
            definitionUnavailable(binding, "unavailable");
            continue;
          }
          const providerId = operationRow?.[execution.providerRef];
          if (typeof providerId !== "string") {
            definitionUnavailable(binding, "unavailable");
            continue;
          }
          const providerRow = (
            await snapshotRowsByFilter(trx, execution.providerTable, {
              id: providerId,
            })
          )[0];
          if (!providerRow) {
            definitionUnavailable(binding, "unavailable");
            continue;
          }
          const connectionRows = normalizeConnectionValueRows(
            await snapshotRowsByFilter(
              trx,
              execution.connectionTable,
              { [execution.connectionProviderRef]: providerId },
            ),
            execution.connectionValuesField,
          );
          const providerAuth = (providerRow.auth ?? null) as Record<
            string,
            unknown
          > | null;
          const declaredScope = connectionScopeOf(providerAuth);
          const allowsPersonal = declaredScope === "user" || declaredScope === "both";
          const allowsTenant = declaredScope === "tenant" || declaredScope === "both";
          const personalOAuth =
            allowsPersonal && providerAuth?.profile === "oauth2AuthorizationCode";
          const bindingNumber = Number(binding.order ?? 0);
          let personalCapture:
            | ReturnType<typeof capturePersonalOAuthConnections>
            | undefined;
          if (personalOAuth) {
            try {
              personalCapture = capturePersonalOAuthConnections(
                connectionRows,
                session.userId,
              );
            } catch {
              // No (single) tenant support row: the organization's side is
              // missing, which comes before any personal sign-in.
              definitionUnavailable(
                binding,
                "connection_required",
                connectionGuidance(providerRow, "organization"),
              );
              continue;
            }
          }
          const eligible = personalCapture
            ? [
                ...personalCapture.personal,
                ...(allowsTenant ? [personalCapture.tenantSupport] : []),
              ]
            : connectionRows
                .filter((row) =>
                  (allowsPersonal && row.ownerUserId === session.userId) ||
                  (allowsTenant &&
                    (row.ownerUserId === null || row.ownerUserId === undefined)),
                )
                .filter(
                  (row): row is Record<string, unknown> & { id: string } =>
                    typeof row.id === "string" && row.id.length > 0,
                )
                .sort((left, right) => compareCodeUnits(left.id, right.id));
          const requiredScopes = Array.isArray(operationRow.requiredScopes)
            ? operationRow.requiredScopes.filter(
                (scope): scope is string => typeof scope === "string",
              )
            : [];
          let missingRequiredScopes = false;
          let needsReauthorization = false;
          let eligibleSourceCount = 0;
          for (const connection of eligible) {
            const connectionValues = (connection[
              execution.connectionValuesField
            ] ?? {}) as Record<string, unknown>;
            if (
              !scopesCovered(requiredScopes, connectionValues?.grantedScopes)
            ) {
              missingRequiredScopes = true;
              continue;
            }
            if (
              providerAuth?.profile === "oauth2AuthorizationCode" &&
              !connectionValues?.accessToken
            ) {
              continue;
            }
            if (
              providerAuth?.profile === "oauth2AuthorizationCode" &&
              accessTokenNeedsRefresh(
                connectionValues,
                refreshLeewaySeconds(providerAuth),
              ) &&
              !looksLikeStoredSecret(connectionValues.refreshToken)
            ) {
              needsReauthorization = true;
              continue;
            }
            const sourceIsPersonal = connection.ownerUserId === session.userId;
            const identity = {
              tenantId,
              actorId: sourceIsPersonal ? session.userId : null,
              scope: sourceIsPersonal ? ("personal" as const) : ("tenant" as const),
              connectionTable: execution.connectionTable,
              connectionId: String(connection.id),
            };
            const sourceReference = mintInvocationSourceReference(identity);
            const internal: CapturedDerivedExecution = {
              entry,
              serviceRow,
              binding,
              operationRow,
              providerRow,
              connectionRows: personalCapture && sourceIsPersonal
                ? [personalCapture.tenantSupport, connection]
                : [connection],
              selectedConnectionId: String(connection.id),
            };
            const fingerprint = authorityFingerprint(internal);
            const validate = async (validationSignal?: AbortSignal) => {
              validationSignal?.throwIfAborted();
              const current = await authorizedSources(
                toolName,
                projectedOnly,
                args,
                validationSignal,
              );
              return current.sources.find(
                (candidate) =>
                  sameInvocationSourceReference(
                    candidate.sourceReference,
                    sourceReference,
                  ) &&
                  candidate.binding === bindingNumber &&
                  candidate.definition.kind === definitionKind &&
                  candidate.definition.id === definitionId &&
                  candidate.definition.version === definitionVersion,
              );
            };
            sources.push({
              sourceReference,
              tenantId: identity.tenantId,
              actorId: identity.actorId,
              toolName,
              scope: identity.scope,
              binding: bindingNumber,
              definition,
              authorityFingerprint: fingerprint,
              internal,
              validate,
            });
            eligibleSourceCount += 1;
          }
          if (eligibleSourceCount === 0) {
            const reauthorize = missingRequiredScopes || needsReauthorization;
            definitionUnavailable(
              binding,
              reauthorize ? "reauthorization_required" : "connection_required",
              connectionGuidance(
                providerRow,
                reauthorize
                  ? "reauthorization"
                  : allowsPersonal && !allowsTenant
                    ? "personal"
                    : providerAuth?.profile === "oauth2AuthorizationCode"
                      ? "tenant_sign_in"
                      : "organization",
              ),
            );
          }
        }
        return { sources, unavailable };
      }
      return { sources: [], unavailable: [] };
    }, { isolationLevel: "repeatable read" });
  };

  const sourceFromReference = async (
    sourceReference: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AuthorizedInvocationSource | undefined> => {
    signal?.throwIfAborted();
    const candidates = await authorizedSources(toolName, false, args, signal);
    const matching = candidates.sources.filter((candidate) =>
      sameInvocationSourceReference(
        candidate.sourceReference,
        sourceReference,
      ),
    );
    return matching.length === 1 ? matching[0] : undefined;
  };

  return {
    authorizedSources,
    sourceFromReference,
  };
}
