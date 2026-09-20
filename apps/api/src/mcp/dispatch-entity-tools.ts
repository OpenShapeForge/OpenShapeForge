// SPDX-License-Identifier: BUSL-1.1
import { createHash, randomUUID } from "node:crypto";
import { GENERIC_DESCRIBE_TOOL_NAME } from "@openshapeforge/operations";
import { getEntityOperationContracts, getGeneratedEntity } from "../operations/entity/index.js";
import { assertEntityValuesValid } from "../operations/entity/input-validation.js";
import { deriveToolName, inputSchemaFromStoredFields } from "./derived-tools.js";
import { collectElicitedValues } from "./elicitation.js";
import { mintConfiguration, handoffModelValues } from "./configuration-handoff.js";
import {
  bindingSelected,
  definitionFieldKeys,
  executeBindingStep,
  mergeOutputs,
  orderedBindings,
  providerUrlTemplates,
  resolveTemplate,
  secretFieldKeys,
  secretUrlPlaceholderError,
  templatePlaceholders,
} from "./declarative-execution.js";
import { failedCheckSummary, testElicitedRow } from "./connection-test.js";
import { connectionTokenSecretScope, scopesCovered } from "./entity-oauth.js";
import {
  accessTokenNeedsRefresh,
  type ConnectionTokenAudit,
  recordConnectionTokenAudit,
  refreshConnectionRowLocked,
  refreshLeewaySeconds,
} from "./connection-token-refresh.js";
import { SecretError } from "../connectors/secrets.js";
import { HttpError } from "../rest/http-error.js";
import {
  connectionNeedsOf,
  connectionProblemError,
  missingRequiredConnectionValues,
} from "./connection-guidance.js";
import { isOrganizationAdministrator } from "./onboarding.js";
import { egressSourceFromResolvedInvocation } from "../modules/invocation-sources.js";
import { mintInvocationSourceReference, sameInvocationSourceReference } from "../modules/source-reference.js";
import { invokeOperation, requireOperationAuthorization } from "../operations/runtime.js";
import {
  type CapturedDerivedExecution,
  type CatalogTool,
  catalog,
  catalogDerivedTools,
  catalogGuideTools,
  connectionScopeOf,
  entityForTable,
  fieldNameForColumn,
  guideToolsForSession,
  serializeRow,
  sessionMayInvoke,
} from "./catalog.js";
import { derivedToolsForSession } from "./derived-session-tools.js";
import {
  assertDeclaredProperties,
  assertOperationWrittenFields,
  invokeTool,
  requireArguments,
} from "./entity-tool-invocation.js";
import {
  describeGenericEntity,
  resolveCrudTool,
  resolveNativeCrudTool,
  withoutEntitySelector,
} from "./entity-tool-projection.js";
import {
  ENTITY_OAUTH_CALLBACK_PATH,
  callbackOrigin,
  configurationFallbackLead,
  elicitationFallback,
  elicitedKeyring,
  publicOriginIsHttps,
  supportsMcpApp,
} from "./handoff-config.js";
import {
  normalizeConnectionValueRows,
  organizationConnectionProblem,
  providerDisplayName,
  readClientCredentials,
  reauthorizationProblem,
  runtimeRowByFilter,
  runtimeRowsByFilter,
  selectOAuthConnectionRow,
  urlSafeConnectionValues,
} from "./session-connections.js";
import {
  type CompletedStep,
  compositionGapError,
  configurationAppResult,
  configurationHandoffResult,
  derivedToolResult,
  failed,
  nativeOperationOutput,
  nativeToolArguments,
  nativeToolOutput,
  ok,
  operationDisplayKey,
  partial,
  unavailableOutcome,
} from "./tool-results.js";
import { ENVELOPE_KEYS, assertSchemaValid, envelopeSchema } from "./tool-schema.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DirectCallScope } from "./tool-dispatch.js";

/**
 * The entity section of tool dispatch. Split out of generated-mcp-server.ts.
 */

/**
 * The entity tools: osf_describe, the dedicated and generic CRUD tools, and
 * — when no static tool owns the name — the derived (row-defined) tools.
 * Always answers: an unknown name is the same NOT_FOUND an unauthorized one gets.
 */
export async function entityToolCall(
  ctx: DirectCallScope,
): Promise<CallToolResult | undefined> {
  const {
    assertInterceptorActive,
    assertParentInvocationActive,
    db,
    egressOwner,
    egressSource,
    extra,
    guidesCalled,
    idempotencyKey,
    internalDerivedDefinition,
    leadCapture,
    locale,
    modulePlatform,
    moduleSession,
    name,
    onDerivedDefinitionChanged,
    operations,
    request,
    selected,
    selectedReference,
    server,
    session,
    signal,
    stateful,
    tables,
  } = ctx;
  if (name === GENERIC_DESCRIBE_TOOL_NAME) {
    try {
      const args = requireArguments(request.params.arguments ?? {});
      return ok({
        data: describeGenericEntity(args.entity, args.operation, session, tables, locale),
        operations: [],
      });
    } catch (error) {
      return failed(error);
    }
  }
  // A generic (`osf_*`) name is carried by one catalog entry per entity, so
  // the `entity` argument is what picks the entry — bounded to the entities
  // this session may invoke the operation on.
  let match: CatalogTool | undefined;
  try {
    match = resolveCrudTool(
      name,
      (request.params.arguments ?? {}) as Record<string, unknown>,
      session,
      tables,
    );
  } catch (error) {
    return failed(error);
  }
  const table = match ? tables.get(match.table) : undefined;
  // An unknown tool and one the caller may not invoke get the same answer:
  // the listing already omitted both, so distinguishing them would leak
  // which entities exist.
  if (
    !match ||
    !table ||
    !sessionMayInvoke(table, match.operation, session)
  ) {
    // Not a static tool — a derived (row-defined) tool may own the name.
    // Execution of derived tools is a later slice: the definition names an
    // intent, but the connection/execution machinery that fulfils it does
    // not exist yet, so the honest answer is a clear failure, not a stub
    // success an agent would act on.
    if (catalogDerivedTools.length > 0) {
      let derived = internalDerivedDefinition
        ? {
            name,
            description: String(
              internalDerivedDefinition.row[
                internalDerivedDefinition.entry.descriptionField
              ] ?? name,
            ),
            inputSchema: inputSchemaFromStoredFields(
              internalDerivedDefinition.row[
                internalDerivedDefinition.entry.inputFieldsField
              ],
              locale,
            ),
            entity: internalDerivedDefinition.entry.entity,
            table: internalDerivedDefinition.entry.table,
            rowId: String(internalDerivedDefinition.row.id ?? ""),
          }
        : (
            await derivedToolsForSession(db, session, tables, locale)
          ).find((tool) => tool.name === name);
      if (leadCapture) {
        const hidden = leadCapture;
        if (deriveToolName(hidden.serviceRow[hidden.entry.keyField]) === name) {
          derived = {
            name,
            description:
              String(hidden.serviceRow[hidden.entry.descriptionField] ?? ""),
            inputSchema: inputSchemaFromStoredFields(
              hidden.serviceRow[hidden.entry.inputFieldsField],
              locale,
            ),
            entity: hidden.entry.entity,
            table: hidden.entry.table,
            rowId: String(hidden.serviceRow.id ?? ""),
          };
        }
      }
      if (derived) {
        const entry =
          leadCapture?.entry ??
          internalDerivedDefinition?.entry ??
          catalogDerivedTools.find(
            (candidate) => candidate.table === derived.table,
          );
        const execution = entry?.execution;
        if (!execution) {
          return failed(
            new HttpError(
              501,
              "NOT_IMPLEMENTED",
              `Tool "${name}" is defined by a stored ${derived.entity} record, but ` +
                `its projection does not declare execution. The definition can be ` +
                `inspected via its ${derived.entity} resource or management tools.`,
            ),
          );
        }
        try {
          const args = (request.params.arguments ?? {}) as Record<
            string,
            unknown
          >;
          assertSchemaValid(derived.inputSchema, args, "arguments");

          const serviceRow =
            leadCapture?.serviceRow ??
            internalDerivedDefinition?.row ??
            (await runtimeRowByFilter(
              db,
              session,
              tables,
              derived.table,
              { id: derived.rowId },
            ));
          if (!serviceRow)
            throw new HttpError(404, "NOT_FOUND", `Unknown tool "${name}".`);

          // Later bindings see earlier outputs alongside the caller's
          // inputs, which is what makes read→act chains expressible. A
          // binding marked optional may fail without failing the call —
          // that is what lets one canonical service span providers and
          // still answer when one of them is down or not yet connected —
          // and every skipped one is reported honestly in `unavailable`.
          const accumulated: Record<string, unknown> = {};
          const unavailable: {
            binding: number;
            outcome: ReturnType<typeof unavailableOutcome>;
          }[] = [];
          const selectedBindings = orderedBindings(
            serviceRow,
            execution.bindingsField,
            // A binding the call's selector input does not choose is not
            // part of this call at all — deliberate routing, not an
            // outage, so it does not surface in `unavailable`.
          ).filter((binding) =>
            bindingSelected(binding, args as Record<string, unknown>),
          );
          // Which bindings this handle stands for. Two selection modes,
          // two meanings: `all-authorized` hands out one handle per
          // (binding, provider) and the caller composes the union — a
          // handle runs ONLY its binding, or a read would fan out N times.
          // A `default` handle stands for the composed call: every
          // selected binding runs in order, each with the one provider the
          // vault chose for it (`composition.steps`). That composition is
          // what makes a two-step mutation service actually take both
          // steps; a query-only definition keeps the one-binding contract
          // so an existing union read is not run twice.
          const composition = selected?.composition;
          const stepCaptures = new Map<
            number,
            {
              capture: CapturedDerivedExecution;
              source: { sourceReference: string; scope: "tenant" | "personal" };
            }
          >();
          if (selected && leadCapture) {
            stepCaptures.set(selected.binding, {
              capture: leadCapture,
              source: selected,
            });
          }
          const composedCall =
            composition !== undefined &&
            [
              leadCapture,
              ...composition.steps.map(
                (step) => step.internal as CapturedDerivedExecution | undefined,
              ),
            ].some((capture) => capture?.operationRow.kind === "mutation");
          if (composedCall) {
            for (const step of composition.steps) {
              const capture = step.internal as CapturedDerivedExecution | undefined;
              if (capture) stepCaptures.set(step.binding, { capture, source: step });
            }
            // Fail before the first write when a required step has no
            // usable source: a gap known up front must never become a
            // half-done call.
            for (const binding of selectedBindings) {
              const order = Number(binding.order ?? 0);
              if (stepCaptures.has(order) || binding.optional === true) continue;
              throw compositionGapError(
                name,
                order,
                composition.unavailable.find((gap) => gap.binding === order),
              );
            }
          }
          const completed: CompletedStep[] = [];
          const bindingsToRun = composedCall || !selected
            ? selectedBindings
            : selectedBindings.filter(
                (binding) => Number(binding.order ?? 0) === selected.binding,
              );
          for (const [position, binding] of bindingsToRun.entries()) {
            const order = Number(binding.order ?? 0);
            const step = stepCaptures.get(order);
            const captured = step?.capture;
            const stepEgressSource = step
              ? egressSourceFromResolvedInvocation(step.source)
              : egressSource;
            if (composedCall && !step) {
              // Optional and without a source: skipped, and said so — the
              // required case was refused above.
              unavailable.push({
                binding: order,
                outcome: unavailableOutcome(
                  compositionGapError(
                    name,
                    order,
                    composition.unavailable.find((gap) => gap.binding === order),
                  ),
                ),
              });
              continue;
            }
            let operationLabel = `binding ${order}`;
            try {
              const operationId = binding[execution.operationRef];
              const operationRow = captured
                ? captured.operationRow
                : typeof operationId === "string"
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
              operationLabel = operationDisplayKey(operationRow);
              const providerId = operationRow[execution.providerRef];
              const providerRow = captured
                ? captured.providerRow
                : typeof providerId === "string"
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
                throw new HttpError(
                  400,
                  "SERVICE_MISCONFIGURED",
                  `The ${execution.operationEntity} references a missing ${execution.providerEntity}.`,
                );
              }
              let connectionRows = captured
                ? captured.connectionRows
                : normalizeConnectionValueRows(
                    await runtimeRowsByFilter(
                      db,
                      session,
                      tables,
                      execution.connectionTable,
                      { [execution.connectionProviderRef]: providerId },
                    ),
                    execution.connectionValuesField,
                  );
              const providerAuth = (providerRow.auth ?? null) as Record<
                string,
                unknown
              > | null;
              if (selectedReference && session.tenantId && !captured) {
                connectionRows = connectionRows.filter((row) =>
                  sameInvocationSourceReference(
                    selectedReference,
                    mintInvocationSourceReference({
                      tenantId: session.tenantId!,
                      actorId:
                        row.ownerUserId === session.userId ? session.userId : null,
                      scope:
                        row.ownerUserId === session.userId ? "personal" : "tenant",
                      connectionTable: execution.connectionTable,
                      connectionId: String(row.id),
                    }),
                  ),
                );
              }
              const elicitScope =
                entityForTable(execution.connectionTable)?.elicitOnCreate
                  ?.sourceTable ?? execution.providerTable;
              let providerForExecution = providerRow;
              let connectionValues: unknown;
              let secretScope = elicitScope;
              let oauthConnectionAudit: ConnectionTokenAudit | undefined;
              const selectedConnectionId = captured?.selectedConnectionId;
              const selectedConnection = selectedConnectionId
                ? connectionRows.find((row) => row.id === selectedConnectionId)
                : connectionRows.length === 1
                  ? connectionRows[0]
                  : undefined;
              const declaredScope = connectionScopeOf(providerAuth);
              if (declaredScope === "both" && !selectedConnection) {
                throw new HttpError(
                  400,
                  "CONNECTION_AMBIGUOUS",
                  "Choose one authorized personal or organization connection for this mutation.",
                );
              }
              const personalExecution =
                declaredScope === "user" ||
                (declaredScope === "both" &&
                  selectedConnection?.ownerUserId === session.userId);
              const effectiveScope = personalExecution ? "user" : "tenant";

              if (personalExecution) {
                // Every personal auth profile resolves ONLY the caller's
                // captured connection. OAuth adds tenant support/config and
                // refresh below; API-key/header/basic profiles use this same
                // personal row without falling into tenant selection.
                const personal = selectOAuthConnectionRow(
                  connectionRows,
                  "user",
                  session.userId,
                );
                if (!personal) {
                  // The organization's side comes first: a person cannot
                  // sign in at a provider whose shared configuration (the
                  // OAuth client, say) nobody has created yet.
                  const needs = connectionNeedsOf(
                    providerAuth,
                    providerRow[
                      entityForTable(execution.connectionTable)?.elicitOnCreate
                        ?.definitionsField ?? ""
                    ],
                  );
                  if (
                    needs.organization &&
                    !connectionRows.some((row) => !row.ownerUserId)
                  ) {
                    throw await organizationConnectionProblem({
                      db,
                      session,
                      tables,
                      execution,
                      entry,
                      providerRow,
                    });
                  }
                  throw connectionProblemError({
                    kind: "personal_missing",
                    adapter: providerDisplayName(providerRow, execution),
                    toolName: name,
                    connectTool: entry?.connect?.name ?? null,
                  });
                }
                if (providerAuth?.profile !== "oauth2AuthorizationCode") {
                  connectionValues =
                    personal[execution.connectionValuesField];
                } else {
                const personalScope = connectionTokenSecretScope(
                  execution.connectionTable,
                );
                oauthConnectionAudit = {
                  sourceTable: execution.providerTable,
                  connectionId: String(personal?.id ?? ""),
                  scope: "user",
                  correlationId: String(extra.requestId ?? randomUUID()),
                };
                let values = (personal?.[execution.connectionValuesField] ??
                  null) as Record<string, unknown> | null;
                if (!values?.accessToken) {
                  throw connectionProblemError({
                    kind: "personal_missing",
                    adapter: providerDisplayName(providerRow, execution),
                    toolName: name,
                    connectTool: entry?.connect?.name ?? null,
                  });
                }
                if (
                  accessTokenNeedsRefresh(
                    values,
                    refreshLeewaySeconds(providerAuth),
                  )
                ) {
                  const keyring = elicitedKeyring();
                  const tenantConnection = connectionRows.find(
                    (row) => !row.ownerUserId,
                  );
                  let credentials: ReturnType<typeof readClientCredentials>;
                  try {
                    credentials = readClientCredentials(
                      tenantConnection,
                      execution.connectionValuesField,
                      elicitScope,
                    );
                  } catch (error) {
                    if (
                      error instanceof HttpError &&
                      error.code === "CONNECTION_MISSING"
                    ) {
                      throw await organizationConnectionProblem({
                        db,
                        session,
                        tables,
                        execution,
                        entry,
                        providerRow,
                      });
                    }
                    throw error;
                  }
                  if (!keyring || typeof providerAuth.tokenUrl !== "string") {
                    throw new HttpError(
                      400,
                      "PROVIDER_MISCONFIGURED",
                      "Token refresh is not configured.",
                    );
                  }
                  const tenantUrlValues = urlSafeConnectionValues(
                    tenantConnection,
                    execution.connectionValuesField,
                    providerRow[
                      entityForTable(execution.connectionTable)
                        ?.elicitOnCreate?.definitionsField ?? ""
                    ],
                    elicitScope,
                  );
                  const connectionTableDef = tables.get(
                    execution.connectionTable,
                  );
                  if (!connectionTableDef)
                    throw new HttpError(
                      500,
                      "INTERNAL",
                      "Connection table is missing.",
                    );
                  try {
                  values = await refreshConnectionRowLocked({
                    db,
                    session,
                    table: connectionTableDef,
                    rowId: String(personal.id),
                    valuesField: execution.connectionValuesField,
                    providerField: execution.connectionProviderRef,
                    expectedProviderId: String(providerId),
                    expectedOwnerUserId: session.userId,
                    refreshLeewaySeconds: refreshLeewaySeconds(providerAuth),
                    audit: oauthConnectionAudit!,
                    tokenUrl: resolveTemplate(providerAuth.tokenUrl as string, tenantUrlValues.plain, "auth.tokenUrl", tenantUrlValues.secretKeys),
                    clientId: credentials.clientId,
                    clientSecret: credentials.clientSecret,
                    egress: Array.isArray(providerRow.egressHosts) ? (providerRow.egressHosts as string[]) : [],
                    keyring,
                    secretScope: personalScope,
                      moduleEgress: {
                      owner: egressOwner,
                      purpose: "oauth",
                      scope: {
                        tenantId: session.tenantId,
                        actorId: session.userId,
                        provider: String(providerRow.id ?? providerId),
                        operation: "refresh_access_token",
                        kind: "mutation",
                        },
                      },
                      ...(signal ? { signal } : {}),
                    });
                  } catch (error) {
                    throw reauthorizationProblem(error, {
                      adapter: providerDisplayName(providerRow, execution),
                      toolName: name,
                      connectTool: entry?.connect?.name ?? null,
                      scope: "user",
                    });
                  }
                }
                // The personal connection holds only tokens; tenant-owned
                // NON-secret configuration (subdomain and friends) still
                // resolves base-URL and path templates, so merge the tenant
                // connection's URL-safe half underneath the personal values.
                // Resolving it HERE keeps the AAD scopes straight: tenant
                // fields decrypt under the elicitation scope, while the merged
                // row executes under the personal scope.
                const tenantConnectionForPlain = connectionRows.find(
                  (row) => !row.ownerUserId,
                );
                const tenantUrlSafe = urlSafeConnectionValues(
                  tenantConnectionForPlain,
                  execution.connectionValuesField,
                  providerRow[
                    entityForTable(execution.connectionTable)?.elicitOnCreate
                      ?.definitionsField ?? ""
                  ],
                  elicitScope,
                );
                connectionValues = { ...tenantUrlSafe.plain, ...values };
                secretScope = personalScope;
                providerForExecution = {
                  ...providerRow,
                  auth: { scheme: "bearer", tokenFrom: "accessToken" },
                };
                }
              } else {
                // Tenant OAuth is bound only to its explicit tenant-owned
                // row. Falling back to a personal row would let one user's
                // authorization power a tenant-wide execution.
                const tenantConnection = selectOAuthConnectionRow(
                  connectionRows,
                  "tenant",
                  session.userId,
                );
                if (!tenantConnection) {
                  throw await organizationConnectionProblem({
                    db,
                    session,
                    tables,
                    execution,
                    entry,
                    providerRow,
                  });
                }
                oauthConnectionAudit = {
                  sourceTable: execution.providerTable,
                  connectionId: String(tenantConnection.id),
                  scope: "tenant",
                  correlationId: String(extra.requestId ?? randomUUID()),
                };
                connectionValues =
                  tenantConnection[execution.connectionValuesField];
                if (providerAuth?.profile === "oauth2AuthorizationCode") {
                  // Tenant-scoped sign-in: one consent covers the tenant; the
                  // tokens live on the tenant connection and execute as bearer.
                  let tenantValues = (connectionValues ?? null) as Record<
                    string,
                    unknown
                  > | null;
                  if (!tenantValues?.accessToken) {
                    throw connectionProblemError({
                      kind: "tenant_sign_in",
                      adapter: providerDisplayName(providerRow, execution),
                      toolName: name,
                      connectTool: entry?.connect?.name ?? null,
                      administrator: isOrganizationAdministrator(session.roles),
                    });
                  }
                  if (
                    accessTokenNeedsRefresh(
                      tenantValues,
                      refreshLeewaySeconds(providerAuth),
                    )
                  ) {
                    const keyring = elicitedKeyring();
                    let credentials: ReturnType<typeof readClientCredentials>;
                    try {
                      credentials = readClientCredentials(
                        tenantConnection,
                        execution.connectionValuesField,
                        elicitScope,
                      );
                    } catch (error) {
                      if (
                        error instanceof HttpError &&
                        error.code === "CONNECTION_MISSING"
                      ) {
                        throw await organizationConnectionProblem({
                          db,
                          session,
                          tables,
                          execution,
                          entry,
                          providerRow,
                          missingValues: missingRequiredConnectionValues(
                            providerRow[
                              entityForTable(execution.connectionTable)
                                ?.elicitOnCreate?.definitionsField ?? ""
                            ],
                            providerAuth,
                            tenantConnection[execution.connectionValuesField],
                          ),
                        });
                      }
                      throw error;
                    }
                    const connectionTableDef = tables.get(
                      execution.connectionTable,
                    );
                    if (
                      !keyring ||
                      !connectionTableDef ||
                      typeof providerAuth.tokenUrl !== "string"
                    ) {
                      throw new HttpError(
                        400,
                        "PROVIDER_MISCONFIGURED",
                        "Tenant token refresh is not configured.",
                      );
                    }
                    const tenantUrlValues = urlSafeConnectionValues(
                      tenantConnection,
                      execution.connectionValuesField,
                      providerRow[
                        entityForTable(execution.connectionTable)
                          ?.elicitOnCreate?.definitionsField ?? ""
                      ],
                      elicitScope,
                    );
                    try {
                    tenantValues = await refreshConnectionRowLocked({
                      db,
                      session,
                      table: connectionTableDef,
                      rowId: String(tenantConnection.id),
                      valuesField: execution.connectionValuesField,
                      providerField: execution.connectionProviderRef,
                      expectedProviderId: String(providerId),
                      expectedOwnerUserId: null,
                      refreshLeewaySeconds:
                        refreshLeewaySeconds(providerAuth),
                      audit: oauthConnectionAudit!,
                      tokenUrl: resolveTemplate(providerAuth.tokenUrl as string, tenantUrlValues.plain, "auth.tokenUrl", tenantUrlValues.secretKeys),
                      clientId: credentials.clientId,
                      clientSecret: credentials.clientSecret,
                      egress: Array.isArray(providerRow.egressHosts) ? (providerRow.egressHosts as string[]) : [],
                      keyring,
                      secretScope: connectionTokenSecretScope(execution.connectionTable),
                      moduleEgress: {
                        owner: egressOwner,
                        purpose: "oauth",
                        scope: {
                          tenantId: session.tenantId,
                          actorId: session.userId,
                          provider: String(providerRow.id ?? providerId),
                          operation: "refresh_access_token",
                          kind: "mutation",
                        },
                      },
                      ...(signal ? { signal } : {}),
                    });
                    } catch (error) {
                      throw reauthorizationProblem(error, {
                        adapter: providerDisplayName(providerRow, execution),
                        toolName: name,
                        connectTool: entry?.connect?.name ?? null,
                        scope: "tenant",
                      });
                    }
                  }
                  // The row mixes AAD scopes: elicited fields were encrypted
                  // under the elicitation scope, tokens under the personal
                  // scope. Resolve the elicited URL-safe half here and keep
                  // only the token fields for the personal-scope execution —
                  // bearer execution never needs the OAuth client secrets.
                  const definitions =
                    providerRow[
                      entityForTable(execution.connectionTable)
                        ?.elicitOnCreate?.definitionsField ?? ""
                    ];
                  const tenantUrlSafe = urlSafeConnectionValues(
                    tenantConnection,
                    execution.connectionValuesField,
                    definitions,
                    elicitScope,
                  );
                  const elicitedKeys = definitionFieldKeys(definitions);
                  connectionValues = {
                    ...tenantUrlSafe.plain,
                    ...Object.fromEntries(
                      Object.entries(tenantValues).filter(
                        ([key]) => !elicitedKeys.has(key),
                      ),
                    ),
                  };
                  secretScope = connectionTokenSecretScope(
                    execution.connectionTable,
                  );
                  providerForExecution = {
                    ...providerRow,
                    auth: { scheme: "bearer", tokenFrom: "accessToken" },
                  };
                }
              }

              const operationScopes = Array.isArray(
                operationRow.requiredScopes,
              )
                ? operationRow.requiredScopes.filter(
                    (scope): scope is string => typeof scope === "string",
                  )
                : [];
              const grantedScopes =
                connectionValues && typeof connectionValues === "object"
                  ? (connectionValues as Record<string, unknown>)
                      .grantedScopes
                  : undefined;
              if (!scopesCovered(operationScopes, grantedScopes)) {
                throw connectionProblemError({
                  kind: "reauthorization",
                  adapter: providerDisplayName(providerRow, execution),
                  toolName: name,
                  connectTool: entry?.connect?.name ?? null,
                  scope: effectiveScope,
                  reason: `does not cover the required scopes: ${operationScopes.join(", ")}`,
                });
              }

              const stepIdempotencyKey = idempotencyKey
                ? createHash("sha256")
                    .update(`${idempotencyKey}\0${order}\0${operationLabel}`)
                    .digest("hex")
                : undefined;
              let outputs;
              try {
                assertParentInvocationActive?.();
                assertInterceptorActive?.();
                outputs = await executeBindingStep({
                  binding,
                  operationRow,
                  providerRow: providerForExecution,
                  connectionValues,
                  serviceInputs: { ...args, ...accumulated },
                  // The platform-owned native provider: run the generated
                  // operation in-process through the same executor an
                  // entity tool call uses, under the caller's own session —
                  // roles, tenant and row-level identity all preserved.
                  native: async (operationKey, inputs) => {
                    const nativeTool = resolveNativeCrudTool(
                      operationKey,
                      inputs,
                    );
                    const nativeTable = nativeTool
                      ? tables.get(nativeTool.table)
                      : undefined;
                    if (!nativeTool || !nativeTable) {
                      // Not an entity tool: a plugin operation by key. It
                      // runs through the operation runtime exactly as its
                      // own transports would (roles, tenancy, contract
                      // validation), whether or not it carries a dedicated
                      // MCP tool — that is what lets a Service hand the
                      // model an operation's content blocks without
                      // spending a slot of the dedicated-tool budget.
                      const bound = operations.get(operationKey);
                      if (!bound) {
                        throw new HttpError(
                          400,
                          "OPERATION_MISCONFIGURED",
                          `Native operation "${operationKey}" is not a generated operation of this deployment.`,
                        );
                      }
                      requireOperationAuthorization(bound.operation, moduleSession);
                      const operationInputs =
                        stepIdempotencyKey &&
                          bound.operation.idempotency.mode === "idempotency-key"
                          ? {
                              ...inputs,
                              [bound.operation.idempotency.inputField!]:
                                stepIdempotencyKey,
                            }
                          : inputs;
                      const produced = await invokeOperation(bound, operationInputs, {
                        db,
                        session: moduleSession,
                        transport: "mcp",
                        ...(modulePlatform
                          ? { platform: modulePlatform.services }
                          : {}),
                      });
                      return nativeOperationOutput(produced);
                    }
                    // `entity` picked the catalog entry; it is not a
                    // column, so it is dropped before the per-entity shape
                    // is built — the same split a direct call makes.
                    const nativeArgs = nativeToolArguments(
                      nativeTool.operation,
                      withoutEntitySelector(nativeTool, inputs) ?? {},
                    );
                    const produced = await invokeTool(
                      nativeTool,
                      entityForTable(nativeTool.table),
                      nativeTable,
                      tables,
                      db,
                      session,
                      nativeArgs,
                    );
                    return nativeToolOutput(produced);
                  },
                  secretScope,
                  providerDefinitions:
                    providerRow[
                      entityForTable(execution.connectionTable)?.elicitOnCreate
                        ?.definitionsField ?? ""
                    ],
                  egress: {
                    owner: egressOwner,
                    purpose: "provider",
                    scope: {
                      tenantId: session.tenantId,
                      actorId: session.userId,
                      provider: String(providerRow.id ?? providerRow.key ?? "provider"),
                      operation: String(operationRow.id ?? operationRow.key ?? "operation"),
                      kind: operationRow.kind === "mutation" ? "mutation" : "query",
                    },
                    ...(stepEgressSource ? { source: stepEgressSource } : {}),
                  },
                  ...(signal ? { signal } : {}),
                  ...(stepIdempotencyKey
                    ? { idempotencyKey: stepIdempotencyKey }
                    : {}),
                });
              } catch (error) {
                if (error instanceof SecretError && oauthConnectionAudit) {
                  try {
                    await recordConnectionTokenAudit({
                      db,
                      session,
                      audit: oauthConnectionAudit,
                      eventType: "connection.reauthorization_required",
                    });
                  } catch {
                    // Stable recovery guidance must survive an audit outage.
                  }
                  throw connectionProblemError({
                    kind: "reauthorization",
                    adapter: providerDisplayName(providerRow, execution),
                    toolName: name,
                    connectTool: entry?.connect?.name ?? null,
                    scope: effectiveScope,
                    reason: "is stored in a form this runtime can no longer read",
                  });
                }
                throw error;
              }
              mergeOutputs(accumulated, outputs);
              completed.push({
                binding: order,
                operation: operationLabel,
                kind: operationRow.kind === "mutation" ? "mutation" : "query",
                outputs,
              });
            } catch (error) {
              if (binding.optional === true) {
                unavailable.push({
                  binding: order,
                  outcome: unavailableOutcome(error),
                });
                continue;
              }
              // A required step failed after an earlier step already
              // wrote: the steps are separate transactions, so nothing is
              // undone — and nothing is hidden either.
              if (completed.some((done) => done.kind === "mutation")) {
                return partial({
                  tool: name,
                  total: bindingsToRun.length,
                  completed,
                  failed: { binding: order, operation: operationLabel, error },
                  notRun: bindingsToRun.slice(position + 1).map((later) => {
                    const laterOrder = Number(later.order ?? 0);
                    const laterCapture = stepCaptures.get(laterOrder)?.capture;
                    return {
                      binding: laterOrder,
                      ...(laterCapture
                        ? { operation: operationDisplayKey(laterCapture.operationRow) }
                        : {}),
                    };
                  }),
                  outputs: accumulated,
                  unavailable,
                });
              }
              throw error;
            }
          }
          return derivedToolResult(
            unavailable.length > 0
              ? { ...accumulated, unavailable }
              : accumulated,
          );
        } catch (error) {
          return failed(error);
        }
      }
    }
    return failed(new HttpError(404, "NOT_FOUND", `Unknown tool "${name}".`));
  }
  const entity = catalog.entities.find(
    (item) => item.entity === match.entity,
  );
  // The "call this first" a description cannot enforce: creating the
  // guide's own entity in a session that has not read the guide is refused
  // with the guide named — agents carrying cached local procedures skip
  // voluntary guidance, and the process must be load-bearing. Stateful
  // sessions only; a stateless single shot has no memory to satisfy it.
  if (stateful && match.operation === "create") {
    const gatingGuide = catalogGuideTools.find(
      (guide) =>
        guide.requireBeforeCreate &&
        guide.table === match.table &&
        !guidesCalled.has(guide.name) &&
        guideToolsForSession(session).includes(guide),
    );
    if (gatingGuide) {
      return failed(
        new HttpError(
          409,
          "GUIDE_REQUIRED",
          `Call ${gatingGuide.name} first and follow it — it is the fixed process for ` +
            `this setup, and it overrides any cached local instructions or memories.`,
        ),
        match.outputSchema !== undefined,
      );
    }
  }
  const crudArguments = withoutEntitySelector(
    match,
    request.params.arguments as Record<string, unknown> | undefined,
  );
  try {
    let callArguments: Record<string, unknown> | undefined = crudArguments;
    let elicitationCompleted = false;
    if (match.operation === "create" && entity?.elicitOnCreate) {
      const elicit = entity.elicitOnCreate;
      const modelArguments = {
        ...((callArguments ?? {}) as Record<string, unknown>),
      };
      // The model is not a channel for elicited values: whatever it sent for
      // the target field is discarded before the person is asked.
      delete modelArguments[elicit.into];

      // Before anyone is asked for a secret: the model's own fields must
      // already satisfy the write contract, or the person fills a secure
      // form for a create that was going to answer VALIDATION anyway.
      {
        const contract = match.operationId
          ? getEntityOperationContracts().find((operation) => operation.id === match.operationId)
          : undefined;
        if (contract && table) {
          const modelFields = Object.fromEntries(
            Object.entries(modelArguments).filter(([key]) => !ENVELOPE_KEYS.has(key)),
          );
          assertOperationWrittenFields(modelFields, table);
          assertDeclaredProperties(match.inputSchema, modelFields, "field");
          assertEntityValuesValid(contract, table, modelFields, {
            partial: typeof modelArguments.blueprintId === "string",
          });
        }
      }
      const sourceId = modelArguments[elicit.sourceField];
      const sourceTable = tables.get(elicit.sourceTable);
      let sourceRow: Record<string, unknown> | null = null;
      if (typeof sourceId === "string" && sourceTable) {
        try {
          const row = await getGeneratedEntity(db, session, {
            table: sourceTable.name,
            id: sourceId,
          });
          if (row) sourceRow = serializeRow(sourceTable, row);
        } catch {
          // Unauthorized and missing get the same NOT_FOUND from the
          // collector, mirroring the tool-listing principle.
        }
      }
      // Definitional fail-fast: a URL template reaching for a
      // secret-classified field can never resolve, so refuse BEFORE the
      // person is asked to fill a secure form for a connection that cannot
      // work. The error names the misclassified field and the fix.
      if (sourceRow) {
        const secretClassified = secretFieldKeys(
          sourceRow[elicit.definitionsField],
        );
        for (const { context, template } of providerUrlTemplates(sourceRow)) {
          for (const key of templatePlaceholders(template)) {
            if (secretClassified.has(key)) {
              throw new HttpError(
                400,
                "SECRET_IN_URL_TEMPLATE",
                `${secretUrlPlaceholderError(key, context).message} Fix the ` +
                  `${elicit.sourceEntity} definition first — nothing has been asked ` +
                  `of the person yet.`,
              );
            }
          }
        }
      }
      const sourceAuth = sourceRow?.auth as
        | Record<string, unknown>
        | null
        | undefined;
      const messagePrefix =
        sourceAuth?.profile === "oauth2AuthorizationCode"
          ? `Before entering these values, register this exact redirect URL on the ` +
            `provider's OAuth client: ${callbackOrigin()}${ENTITY_OAUTH_CALLBACK_PATH}`
          : undefined;
      try {
        callArguments = await collectElicitedValues({
          server,
          elicit,
          sourceRow,
          values: modelArguments,
          relatedRequestId: extra.requestId,
          locale,
          ...(messagePrefix ? { messagePrefix } : {}),
        });
        elicitationCompleted = true;
        // A Connection to a PERSONAL provider belongs to the person who
        // just entered its values, and to nobody else. Until this existed,
        // only the OAuth callback set an owner, so a personal provider
        // configured with a password (an IMAP mailbox, an LDAP bind) landed
        // as an organization row that row-level security shows to everyone
        // — the credential of one employee, readable by the next. The owner
        // comes from the verified session, never from tool input.
        if (
          connectionScopeOf(sourceAuth) === "user" &&
          session.userId &&
          table.columns.some(
            (column) => fieldNameForColumn(column) === "ownerUserId",
          )
        ) {
          callArguments = {
            ...(callArguments as Record<string, unknown>),
            ownerUserId: session.userId,
          };
        }
      } catch (error) {
        const reason = elicitationFallback(error);
        if (!reason || !sourceRow) throw error;
        // The in-band form did not happen — hand the person a browser URL
        // to the same form instead of dead-ending the setup.
        const definitions = Array.isArray(sourceRow[elicit.definitionsField])
          ? (sourceRow[elicit.definitionsField] as Record<string, unknown>[])
          : [];
        const required = Array.isArray(
          (match.inputSchema as { required?: unknown } | undefined)?.required,
        )
          ? ((match.inputSchema as { required: unknown[] }).required as string[])
          : [];
        const minted = await mintConfiguration({
          db,
          tenantId: session.tenantId as string,
          userId: session.userId as string,
          table: table.name,
          elicit,
          modelValues: handoffModelValues({
            required,
            elicit,
            modelValues: modelArguments,
            sourceRow,
          }),
          definitions,
          displayName: String(
            sourceRow.name ?? entity?.entity ?? "this record",
          ),
          messagePrefix,
        });
        const listToolName = catalog.tools.find(
          (candidate) =>
            candidate.table === match.table && candidate.operation === "list",
        )?.name;
        const continuation = {
          action: "configure",
          status: "awaiting_person",
          expiresInSeconds: minted.expiresInSeconds,
          // Machine-readable continuation: the record exists once the
          // person saved the form; this is how to observe that.
          ...(listToolName ? { resumeWith: listToolName } : {}),
        };
        const waitInstruction =
          " Then wait by checking, not by asking: poll resumeWith every ten " +
          "seconds or so — the record exists once they have saved. Only if " +
          "nothing has appeared after about three minutes, ask the person to tell " +
          "you when they are done.";
        // The private MCP App only where its iframe can render (https
        // origin); every other client gets the URL in the open.
        if (supportsMcpApp(server) && publicOriginIsHttps()) {
          return configurationAppResult(
            {
              ...continuation,
              instructions:
                configurationFallbackLead(reason, "app") +
                waitInstruction,
            },
            minted.token,
            String(sourceRow.name ?? entity?.entity ?? "this record"),
          );
        }

        return configurationHandoffResult({
          continuation,
          token: minted.token,
          expiresInSeconds: minted.expiresInSeconds,
          definitions,
          instructions:
            configurationFallbackLead(reason, "external") +
            waitInstruction,
        });
      }
      // Verify the accepted values against the provider BEFORE anything is
      // stored — the same three checks test_connection runs later, so a
      // wrong subdomain or refused credential fails HERE, not on the first
      // real call. What is honestly unverifiable (no probe declared,
      // sign-in credentials before consent) reports skipped and saves.
      const storedValues = (
        callArguments as Record<string, unknown> | undefined
      )?.[elicit.into];
      if (sourceRow && storedValues && typeof storedValues === "object") {
        const report = await testElicitedRow({
          row: { [elicit.into]: storedValues },
          sourceRow,
          elicit,
          table: table.name,
          egress: {
            owner: egressOwner,
            purpose: "probe",
            scope: {
              tenantId: session.tenantId,
              actorId: session.userId,
              provider: String(sourceRow.id ?? entity?.entity ?? "provider"),
              operation: "test_connection",
              kind: "query",
            },
          },
        });
        if (!report.ok) {
          throw new HttpError(
            400,
            "CONNECTION_REJECTED",
            `Nothing was created — the entered configuration failed verification ` +
              `against ${report.source}: ${failedCheckSummary(report)} ` +
              `Run the create again so the person can correct the values.`,
          );
        }
      }
    }
    {
      // Validate what the MODEL sent against the advertised schema — before
      // elicited values join, since those are server-set and outside it.
      const modelSent = (crudArguments ?? {}) as Record<string, unknown>;
      const elicitField = entity?.elicitOnCreate?.into;
      const toValidate =
        match.operation === "create" && elicitField
          ? Object.fromEntries(
              Object.entries(modelSent).filter(
                ([key]) => key !== elicitField,
              ),
            )
          : modelSent;
      // Before the advertised schema does: a `writtenBy` field is absent from
      // that schema, so ajv would call it an additional property and send the
      // caller hunting for a typo instead of naming the operation.
      assertOperationWrittenFields(
        match.operation === "update"
          ? ((toValidate.values ?? {}) as Record<string, unknown>)
          : toValidate,
        table,
      );
      const contract = match.operationId
        ? getEntityOperationContracts().find(
            (operation) => operation.id === match.operationId,
          )
        : undefined;
      const expectedVersionField = contract?.concurrency?.version?.field;
      // An entity create's or update's authored values are the runtime's to
      // judge, once, for every interface, so MCP gets the same VALIDATION +
      // violations[] answer REST and GraphQL do instead of a private ajv
      // verdict. A plugin Operation owns its input contract (a document
      // with its version and artifact), so its tool is held to the
      // advertised schema as a whole.
      const entityBacked = contract !== undefined && contract.implementation?.type !== "plugin";
      // A field this session's tool does not advertise (immutable on update,
      // withheld, server-managed) is refused by name before anything else,
      // so the answer names the field whatever else the call is missing.
      if (entityBacked && match.operation === "update") {
        if (toValidate.values && typeof toValidate.values === "object" && !Array.isArray(toValidate.values)) {
          assertDeclaredProperties(
            (match.inputSchema.properties as Record<string, Record<string, unknown>> | undefined)?.values,
            toValidate.values as Record<string, unknown>,
            "field",
          );
        }
      } else if (entityBacked && match.operation === "create") {
        assertDeclaredProperties(match.inputSchema, toValidate, "field");
      }
      // The edge checks the ENVELOPE (identity, controls, their types).
      assertSchemaValid(
        entityBacked ? envelopeSchema(match.inputSchema, match.operation) : match.inputSchema,
        toValidate,
        "arguments",
        expectedVersionField,
      );
    }
    const outcome = await invokeTool(
      match,
      entity,
      table,
      tables,
      db,
      session,
      callArguments,
      elicitationCompleted,
    );
    signal?.throwIfAborted();
    // A successful mutation on a table whose rows project as tools changes
    // other sessions' tool lists — tell them, so they re-list instead of
    // discovering the change on their next reconnect.
    if (
      onDerivedDefinitionChanged &&
      !(outcome as { isError?: boolean }).isError &&
      match.operation !== "get" &&
      match.operation !== "list" &&
      catalogDerivedTools.some((entry) => entry.table === match.table)
    ) {
      onDerivedDefinitionChanged(match.table, session.tenantId ?? null);
    }
    return outcome;
  } catch (error) {
    return failed(error, match.outputSchema !== undefined);
  }
}
