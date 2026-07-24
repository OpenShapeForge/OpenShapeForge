// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
/**
 * Shared view/presentation normalization used by both semantic checks and the
 * view compiler, extracted to eliminate duplication between those two stages.
 *
 * Handles two authoring shapes: single-context presentations (inline ui: on
 * core/profile entities) and multi-context presentations (standalone .view.yaml
 * files with per-context blocks). Infers the presentation type (list, detail,
 * form, summary, cards, listItem, workspace) and kind (page vs embedded) from naming
 * conventions
 * when not explicitly declared.
 *
 * Input: raw presentation records from authoring YAML.
 * Output: normalized Record<string, PresentationDefinition> with type/kind set.
 */
import type {
  ItemAction,
  PresentationDefinition,
  Presentations,
  ViewAction,
  ViewRowAction,
  ViewPresentationDefinition,
} from "./types.js";

export const VIEW_META_KEYS = new Set(["kind", "type", "itemAction", "actions", "rowActions"]);

export function normalizeSingleContextPresentations(raw?: Presentations): Record<string, PresentationDefinition> {
  const normalized: Record<string, PresentationDefinition> = {};
  if (!raw) return normalized;

  for (const [name, value] of Object.entries(raw)) {
    normalized[name] = normalizePresentation(name, value as PresentationDefinition);
  }

  return normalized;
}

export function normalizeMultiContextPresentations(
  raw: Record<string, ViewPresentationDefinition>
): Record<string, Record<string, PresentationDefinition>> {
  const normalized: Record<string, Record<string, PresentationDefinition>> = {};

  for (const [name, value] of Object.entries(raw ?? {})) {
    const kind = inferPresentationKind(name, value.kind, value.type);
    const type = inferPresentationType(name, value.type);
    const defaultItemAction = value.itemAction as ItemAction | undefined;
    const defaultActions = value.actions as ViewAction[] | undefined;
    const defaultRowActions = value.rowActions as ViewRowAction[] | undefined;

    for (const [key, contextValue] of Object.entries(value)) {
      if (VIEW_META_KEYS.has(key)) continue;
      if (!contextValue || typeof contextValue !== "object") continue;

      normalized[key] ??= {};
      normalized[key][name] = normalizePresentation(name, {
        ...(contextValue as Record<string, unknown>),
        kind,
        type,
        itemAction: (contextValue as Record<string, unknown>).itemAction ?? defaultItemAction,
        actions: (contextValue as Record<string, unknown>).actions ?? defaultActions,
        rowActions: (contextValue as Record<string, unknown>).rowActions ?? defaultRowActions,
      } as PresentationDefinition);
    }
  }

  return normalized;
}

export function inferPresentationType(
  name: string,
  explicit?: string
): "list" | "detail" | "form" | "summary" | "cards" | "listItem" | "workspace" {
  if (
    explicit === "list"
    || explicit === "detail"
    || explicit === "form"
    || explicit === "summary"
    || explicit === "cards"
    || explicit === "listItem"
    || explicit === "workspace"
  ) {
    return explicit;
  }
  if (name === "list" || name === "detail" || name === "form" || name === "workspace") return name;
  return "list";
}

export function inferPresentationKind(
  name: string,
  explicitKind?: string,
  explicitType?: string
): "page" | "embedded" {
  if (explicitKind === "page" || explicitKind === "embedded") return explicitKind;
  const type = explicitType ?? name;
  return type === "list" || type === "detail" || type === "form" || type === "workspace" ? "page" : "embedded";
}

export function normalizePresentation(name: string, presentation: PresentationDefinition): PresentationDefinition {
  return {
    ...presentation,
    kind: inferPresentationKind(name, presentation.kind, presentation.type),
    type: inferPresentationType(name, presentation.type),
  } as PresentationDefinition;
}
