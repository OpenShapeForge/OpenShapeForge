// SPDX-License-Identifier: BUSL-1.1
import { deriveToolName, inputSchemaFromStoredFields } from "./derived-tools.js";
import { bindingSelected } from "./declarative-execution.js";
import { loadOrderedBindings } from "./execution-bindings.js";
import { HttpError } from "../rest/http-error.js";
import { type CapturedDerivedExecution, catalogDerivedTools } from "./catalog.js";
import { derivedToolsForSession } from "./derived-session-tools.js";
import { runtimeBindingReader, runtimeRowByFilter } from "./session-connections.js";
import { failed } from "./tool-results.js";
import {
  type CompletedStep,
  compositionGapError,
  derivedToolResult,
  unavailableOutcome,
} from "./composed-results.js";
import { assertSchemaValid } from "./tool-schema.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DirectCallScope } from "./tool-dispatch.js";
import { runDerivedBinding } from "./dispatch-derived-binding.js";

/**
 * The derived-tool section of tool dispatch. Split out of the entity section.
 */

/**
 * A derived (row-defined) tool: the Service row the name stands for,
 * resolved per session, and its bindings run in order against the
 * providers the invocation source vault selected. Answers `undefined` when
 * no derived definition owns the name.
 */
export async function derivedToolCall(
  ctx: DirectCallScope,
): Promise<CallToolResult | undefined> {
  const {
    assertInterceptorActive,
    assertParentInvocationActive,
    db,
    egressOwner,
    egressSource,
    extra,
    idempotencyKey,
    internalDerivedDefinition,
    leadCapture,
    locale,
    modulePlatform,
    moduleSession,
    name,
    operations,
    request,
    selected,
    selectedReference,
    session,
    signal,
    tables,
  } = ctx;
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
        const selectedBindings = (
          await loadOrderedBindings(
            execution,
            serviceRow,
            runtimeBindingReader(db, session, tables),
          )
        ).filter((binding) =>
          // A binding the call's selector input does not choose is not
          // part of this call at all — deliberate routing, not an
          // outage, so it does not surface in `unavailable`.
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
          const outcome = await runDerivedBinding(
            {
              ...ctx,
              args: args as Record<string, unknown>,
              accumulated,
              unavailable,
              completed,
              bindingsToRun,
              composedCall,
              composition,
              stepCaptures,
              entry,
              execution,
            },
            position,
            binding,
          );
          if (outcome !== undefined) return outcome;
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
  return undefined;
}
