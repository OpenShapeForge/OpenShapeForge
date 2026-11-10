// SPDX-License-Identifier: BUSL-1.1
/**
 * Rows of catalogue entities as the runtime hands them on: serialised by
 * field name, connection scopes read from an Adapter's auth block, and the
 * mutation controls a call carries beside its values. Split out of catalog.ts.
 */

import { serializeEntityRow } from "../operations/entity/serialize-result.js";
import { createHash } from "node:crypto";
import { compareCodeUnits } from "@openshapeforge/operations";
import type { RuntimeNativeMcpTool, RuntimeOperationDefinition } from "@openshapeforge/plugin-runtime";
import type { Tool } from "@modelcontextprotocol/server";
import { deriveToolName } from "./derived-tools.js";
import { localizedText, type ResolvedLocale } from "./locale.js";
import {
  canonicalRuntimeOperationSchema,
  runtimeOperationEnvelopeSchema,
} from "./operation-search.js";
import {
  type CapturedDerivedExecution,
  type CatalogEntity,
  type GeneratedTable,
  type ProjectedRuntimeOperationTool,
  catalog,
} from "./catalog.js";
import { oauthCallbackUrl } from "./handoff-config.js";
export function entityMutationControls(args: Record<string, unknown>) {
  return {
    ...(typeof args.blueprintId === "string" ? { blueprintId: args.blueprintId } : {}),
    ...(typeof args.expectedVersion === "string"
      ? { expectedVersion: args.expectedVersion }
      : {}),
    ...(typeof args.leaseToken === "string"
      ? { leaseToken: args.leaseToken }
      : {}),
    ...(typeof args.confirmed === "boolean"
      ? { confirmed: args.confirmed }
      : {}),
    ...(typeof args.confirmationToken === "string"
      ? { confirmationToken: args.confirmationToken }
      : {}),
    ...(typeof args.confirmationAnswer === "string"
      ? { confirmationAnswer: args.confirmationAnswer }
      : {}),
    // The field-binding controls, passed on exactly as sent: a shape the
    // runtime refuses must not be dropped here, because a dropped binding
    // reads as a binding that was accepted.
    ...(args.bindings !== undefined ? { bindings: args.bindings } : {}),
    ...(args.unbind !== undefined ? { unbind: args.unbind } : {}),
  };
}

export const __entityMutationControlsForTests = entityMutationControls;

export function fieldNameForColumn(column: GeneratedTable["columns"][number]) {
  return (
    column.sourceField ??
    column.name.replace(/_([a-z0-9])/g, (_match, char: string) =>
      char.toUpperCase(),
    )
  );
}

export function serializeRow(table: GeneratedTable, row: Record<string, unknown>) {
  return serializeEntityRow(table, row);
}

/**
 * Whether a provider's connections are per-employee. Explicit
 * auth.connectionScope wins; absent, personal sign-in implies "user" and
 * everything else "tenant".
 */
export function connectionScopeOf(
  auth: Record<string, unknown> | null | undefined,
): "user" | "tenant" | "both" {
  if (
    auth?.connectionScope === "user" ||
    auth?.connectionScope === "tenant" ||
    auth?.connectionScope === "both"
  ) {
    return auth.connectionScope;
  }
  return auth?.profile === "oauth2AuthorizationCode" ? "user" : "tenant";
}

export let oauthProviderTablesCache: Set<string> | undefined;

export function oauthProviderTables(): Set<string> {
  oauthProviderTablesCache ??= new Set(
    (catalog.derivedTools ?? [])
      .filter((entry) => entry.execution)
      .map((entry) => entry.execution!.providerTable),
  );
  return oauthProviderTablesCache;
}

export function serializeRowForEntity(
  _entity: CatalogEntity | undefined,
  table: GeneratedTable,
  row: Record<string, unknown>,
) {
  const serialized = serializeRow(table, row);
  // A provider declaring personal sign-in needs its OAuth client registered
  // with THIS server's redirect URL — a fact only this process knows, so it
  // rides along on the row instead of being asked of anyone.
  const auth = serialized.auth as Record<string, unknown> | null | undefined;
  if (
    oauthProviderTables().has(table.name) &&
    auth &&
    typeof auth === "object" &&
    auth.profile === "oauth2AuthorizationCode"
  ) {
    serialized.oauthRedirectUrl = oauthCallbackUrl();
  }
  return serialized;
}

export function stableSnapshotJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSnapshotJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableSnapshotJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function authorityFingerprint(capture: CapturedDerivedExecution): string {
  return createHash("sha256")
    .update(stableSnapshotJson(capture))
    .digest("base64url");
}

/**
 * A discovered tool as the upstream server describes it. No field is derived
 * from the Operation's effects: those are core's conservative reading, the
 * annotations are the server's own hints, and neither stands in for the other.
 */
function projectNativeMcpTool(
  definition: RuntimeOperationDefinition,
  native: RuntimeNativeMcpTool,
  locale: ResolvedLocale,
): ProjectedRuntimeOperationTool {
  const description = localizedText(definition.description, locale);
  // Upstream resources are not served here, so a UI reference could only ever
  // resolve to one of this server's own apps, such as its secure input form.
  const meta = native.meta ? structuredClone(native.meta) as Record<string, unknown> : undefined;
  if (meta) {
    delete meta.ui;
    delete meta["ui/resourceUri"];
  }
  return {
    definition,
    tool: {
      name: native.name,
      ...(native.title ? { title: native.title } : {}),
      ...(description ? { description } : {}),
      inputSchema: canonicalRuntimeOperationSchema(
        definition.input,
        definition.id,
        "input",
      ) as Tool["inputSchema"],
      ...(native.outputSchema
        ? { outputSchema: structuredClone(native.outputSchema) as Tool["outputSchema"] }
        : {}),
      ...(native.annotations
        ? { annotations: structuredClone(native.annotations) as Tool["annotations"] }
        : {}),
      ...(meta ? { _meta: meta as Tool["_meta"] } : {}),
    },
  };
}

export function projectRuntimeOperationTool(
  definition: RuntimeOperationDefinition,
  locale: ResolvedLocale,
): ProjectedRuntimeOperationTool {
  if (definition.nativeMcpTool) return projectNativeMcpTool(definition, definition.nativeMcpTool, locale);
  const name = deriveToolName(definition.key);
  if (!name) {
    throw new Error(
      `Runtime Operation ${JSON.stringify(definition.id)} has no usable MCP key.`,
    );
  }
  const title = localizedText(definition.name, locale) ?? definition.id;
  const description = localizedText(definition.description, locale) ?? title;
  return {
    definition,
    tool: {
      name,
      title,
      description,
      inputSchema: canonicalRuntimeOperationSchema(
        definition.input,
        definition.id,
        "input",
      ) as Tool["inputSchema"],
      outputSchema: runtimeOperationEnvelopeSchema(definition) as Tool["outputSchema"],
      annotations: {
        title,
        readOnlyHint:
          definition.effects.data === "read" &&
          definition.effects.external !== "write",
        destructiveHint: definition.effects.data === "delete",
        idempotentHint:
          definition.reliability.idempotency.mode !== "none",
      },
    },
  };
}
