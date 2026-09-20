// SPDX-License-Identifier: BUSL-1.1
import type { DbSessionInput } from "../db/session.js";
import {
  createGeneratedEntityForTable,
  listGeneratedEntitiesForTable,
  updateGeneratedEntityForTable,
} from "../operations/entity/index.js";
import { deriveToolName, derivedHelperAvailable } from "./derived-tools.js";
import { HttpError } from "../rest/http-error.js";
import { catalogDerivedTools } from "./catalog.js";
import { serializeRow } from "./catalog-rows.js";
import { derivedToolsForSession } from "./derived-session-tools.js";
import { requireArguments } from "./entity-tool-guards.js";
import { failed, ok } from "./tool-results.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DirectCallScope } from "./tool-dispatch.js";


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
      !derivedHelperAvailable(personalizationEntry, "personalization", session.roles) ||
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
