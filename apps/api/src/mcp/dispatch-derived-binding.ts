// SPDX-License-Identifier: BUSL-1.1
/**
 * One binding of a derived tool. Split out of the derived-tool section of
 * tool dispatch: the loop body, verbatim, with `continue` spelled as an
 * undefined answer.
 */
import { withDbSession } from "../db/session.js";
import { delegatedConnectionRow, connectionGrantFingerprint } from "../modules/connection-use-grants.js";
import { observeDelegatedProviderFailure, revalidateConnectionDelegation, isDelegatedConnection } from "./connection-delegation.js";
import { ownedByActingRelation } from "../db/acting-relation.js";
import { createHash } from "node:crypto";
import { type DerivedToolsCatalogEntry } from "./derived-tools.js";
import { executeBindingStep, mergeOutputs } from "./declarative-execution.js";
import { connectionScopesCovered } from "./entity-oauth.js";
import { recordConnectionTokenAudit } from "./connection-token-refresh.js";
import { ProviderOutcomeError } from "../connectors/provider-outcome.js";
import { SecretError } from "../connectors/secrets.js";
import { HttpError } from "../rest/http-error.js";
import { connectionProblemError } from "./connection-guidance.js";
import { isExpectedConnectionUnavailable } from "./connection-expectation.js";
import { egressSourceFromResolvedInvocation } from "../modules/invocation-sources.js";
import { mintInvocationSourceReference, sameInvocationSourceReference } from "../modules/source-reference.js";
import { type CapturedDerivedExecution, entityForTable } from "./catalog.js";
import {
  normalizeConnectionValueRows,
  providerDisplayName,
  runtimeRowByFilter,
  runtimeRowsByFilter,
} from "./session-connections.js";
import { failed } from "./tool-results.js";
import {
  type CompletedStep,
  compositionGapError,
  operationDisplayKey,
  partial,
  unavailableOutcome,
} from "./composed-results.js";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { DirectCallScope } from "./tool-dispatch.js";

import { resolveDerivedConnection } from "./dispatch-derived-connection.js";
import { nativeBindingInvoker } from "./dispatch-native-binding.js";

type JsonRecord = Record<string, unknown>;
/**
 * What one binding of a derived tool runs with, beyond the call itself: the
 * call's parsed arguments, the bindings selected for it, the sources the
 * vault composed, and the accumulators the steps write into.
 */
export type DerivedBindingScope = DirectCallScope & {
  args: Record<string, unknown>;
  accumulated: Record<string, unknown>;
  unavailable: { binding: number; outcome: ReturnType<typeof unavailableOutcome> }[];
  completed: CompletedStep[];
  bindingsToRun: JsonRecord[];
  composedCall: boolean;
  composition: NonNullable<DirectCallScope["selected"]>["composition"] | undefined;
  stepCaptures: Map<
    number,
    {
      capture: CapturedDerivedExecution;
      source: { sourceReference: string; scope: "tenant" | "personal" };
    }
  >;
  entry: DerivedToolsCatalogEntry | undefined;
  execution: NonNullable<DerivedToolsCatalogEntry["execution"]>;
};

/**
 * One binding of a derived tool, at its position in the composed call:
 * resolves the source and connection it runs against, invokes the provider
 * or native Operation and merges the outputs. Answers `undefined` to move
 * on to the next binding (the former `continue`), a result to end the call
 * (a partial result after a failed required step); everything else throws.
 */
export async function runDerivedBinding(
  scope: DerivedBindingScope,
  position: number,
  binding: JsonRecord,
): Promise<CallToolResult | undefined> {
  const {
    accumulated,
    args,
    assertInterceptorActive,
    assertParentInvocationActive,
    bindingsToRun,
    completed,
    composedCall,
    composition,
    db,
    egressOwner,
    egressSource,
    entry,
    execution,
    extra,
    idempotencyKey,
    modulePlatform,
    moduleSession,
    name,
    operations,
    selectedReference,
    session,
    signal,
    stepCaptures,
    tables,
    unavailable,
  } = scope;
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
          // A composed call always has its composition (composedCall is
          // `composition !== undefined && …` in the caller).
          composition!.unavailable.find((gap) => gap.binding === order),
        ),
      ),
    });
    return undefined;
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
    const delegation = await revalidateConnectionDelegation(session);
    if (delegation) {
      const service = scope.internalDerivedDefinition?.row;
      if (providerRow.transport !== 'rest' || !service || connectionGrantFingerprint({ execution, service, binding, capability: operationRow, adapter: providerRow }) !== delegation.executionFingerprint) {
        throw new HttpError(403, 'CONNECTION_CONSENT_REQUIRED', 'The delegated service changed after permission was granted.');
      }
      const table = tables.get(execution.connectionTable);
      if (!table) throw new HttpError(403, 'CONNECTION_CONSENT_REQUIRED', 'The delegated connection is unavailable.');
      const delegated = await withDbSession(db, session, trx => delegatedConnectionRow(trx, session, table));
      if (!delegated || delegated[execution.connectionProviderRef] !== providerId) throw new HttpError(403, 'CONNECTION_CONSENT_REQUIRED', 'The delegated provider is unavailable.');
      connectionRows = [...connectionRows.filter(row => !row.ownerUserId), delegated];
    }
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
              (isDelegatedConnection(session, execution.connectionTable, row) || ownedByActingRelation(row.ownerUserId, session)) ? session.userId : null,
            scope:
              (isDelegatedConnection(session, execution.connectionTable, row) || ownedByActingRelation(row.ownerUserId, session)) ? "personal" : "tenant",
            connectionTable: execution.connectionTable,
            connectionId: String(row.id),
          }),
        ),
      );
    }
    const {
      providerForExecution,
      connectionValues,
      secretScope,
      oauthConnectionAudit,
      effectiveScope,
    } = await resolveDerivedConnection({
      ...scope,
      captured,
      providerId,
      providerRow,
      providerAuth,
      connectionRows,
    });
    const operationScopes = Array.isArray(
      operationRow.requiredScopes,
    )
      ? operationRow.requiredScopes.filter(
          (scope): scope is string => typeof scope === "string",
        )
      : [];
    if (!connectionScopesCovered(operationScopes, providerAuth, connectionValues)) {
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
      await revalidateConnectionDelegation(session);
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
        native: nativeBindingInvoker(
          { db, session, tables, operations, moduleSession, modulePlatform },
          stepIdempotencyKey,
        ),
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
      if (error instanceof ProviderOutcomeError) observeDelegatedProviderFailure(session,error.providerStatus);
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
    // `optional` says a SOURCE may be unavailable: a binding whose Adapter
    // nobody configured, whose provider is down, whose scopes fall short. The
    // expected-Connection refusal is not that. It says this step would have
    // run against an account other than the one the caller demanded, and the
    // invocation's answer — including the Connection its capture names — is
    // only meaningful if nothing in it ever reached another account. Absorbing
    // it would turn the refusal into a report that the step was merely
    // skipped, and let the Service answer success while naming the account the
    // OTHER bindings used. So it propagates whatever the binding declares, for
    // this Service's bindings and for those of any Service nested inside it,
    // and every other optional failure is absorbed exactly as before.
    if (binding.optional === true && !isExpectedConnectionUnavailable(error)) {
      unavailable.push({
        binding: order,
        outcome: unavailableOutcome(error),
      });
      return undefined;
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
  return undefined;
}
