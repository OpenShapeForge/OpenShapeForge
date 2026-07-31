// SPDX-License-Identifier: BUSL-1.1
/**
 * Column helper that renders the row-actions affordance on a DataTable row.
 *
 * Extracted from the legacy `EntityList` so action authoring, visibility/
 * disabled DSL evaluation, and dispatch can be reused across every consumer
 * of the new `DataTable`.
 */

import { createElement } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  TableRowActionsMenu,
  type TableRowAction,
} from "@/components/ui/data-table/table-row-actions-menu";
import { matchesVisibility, type VisibilityConfig } from "./visibility-dsl";
import type { LocalizedText } from "./map-schema-columns";

const ENTITY_LIST_ACTION_EVENT = "openshapeforge:entity-list-action";

export interface EntityListActionDefinition {
  label?: LocalizedText;
  icon?: string;
  route?: string;
  mutation?: string;
  targetRef?: string;
  surface?: "modal" | "sheet" | "inline";
  inputRef?: string;
  payload?: Record<string, string | number | boolean>;
  confirm?: LocalizedText;
  tone?: "default" | "destructive";
}

export interface EntityListRowActionConfig {
  actionRef: string;
  label?: LocalizedText;
  icon?: string;
  payload?: Record<string, string | number | boolean>;
  confirm?: LocalizedText;
  tone?: "default" | "destructive";
  visibleWhen?: VisibilityConfig;
  disabledWhen?: VisibilityConfig;
  disabledMessage?: LocalizedText;
}

export interface EntityListAction {
  key: string;
  label: string;
  icon?: string;
  hrefTemplate?: string;
  mutation?: string;
  targetRef?: string;
  surface?: "modal" | "sheet" | "inline";
  inputRef?: string;
  payload?: Record<string, string | number | boolean>;
  confirm?: string;
  tone?: "default" | "destructive";
  disabledMessage?: string;
  visibleWhen?: VisibilityConfig;
  disabledWhen?: VisibilityConfig;
  variant?: "default" | "destructive";
}

export interface ActionEventDetail<TData> {
  action: EntityListAction;
  row: TData;
  payload: Record<string, string | number | boolean> | undefined;
}

export interface CreateActionsColumnOptions<TData extends Record<string, unknown>> {
  /** Direct action list (backwards compatible). */
  actions?: EntityListAction[];
  /** Action definitions keyed by `actionRef`. */
  actionDefinitions?: Record<string, EntityListActionDefinition>;
  /** Per-row action overrides referencing `actionDefinitions`. */
  rowActions?: EntityListRowActionConfig[];
  routes?: Record<string, LocalizedText | string>;
  lang: string;
  /**
   * Called with the resolved action + row. If omitted, the helper falls back
   * to dispatching a `openshapeforge:entity-list-action` window event to preserve
   * compatibility during the migration.
   */
  onAction?: (detail: ActionEventDetail<TData>) => void;
  /** Accessible label for the multi-action trigger. */
  triggerLabel?: string;
  /** Accessible label for the header cell. */
  headerLabel?: string;
}

function resolveLocalizedText(
  value: LocalizedText | undefined,
  fallback: string | undefined,
  lang: string,
): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, string | undefined>;
    const primary = record[lang];
    if (typeof primary === "string" && primary.length > 0) return primary;
    if (typeof record.en === "string" && record.en.length > 0) return record.en;
    if (typeof record.nl === "string" && record.nl.length > 0) return record.nl;
    return (
      Object.values(record).find(
        (entry): entry is string => typeof entry === "string" && entry.length > 0,
      ) ?? fallback
    );
  }
  return fallback;
}

function getNestedValue(input: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, input);
}

function resolveTemplateString(
  template: string,
  row: Record<string, unknown>,
  options: { encode?: boolean } = {},
): string {
  const { encode = false } = options;
  return template.replace(/\{\{(.+?)\}\}/g, (_, expression: string) => {
    for (const candidate of expression.split("||").map((part) => part.trim()).filter(Boolean)) {
      const value = getNestedValue(row, candidate);
      if (value != null && value !== "") {
        const stringValue = String(value);
        return encode ? encodeURIComponent(stringValue) : stringValue;
      }
    }
    return "";
  });
}

function resolvePayload(
  payload: Record<string, string | number | boolean> | undefined,
  row: Record<string, unknown>,
): Record<string, string | number | boolean> | undefined {
  if (!payload) return undefined;
  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [
      key,
      typeof value === "string" ? resolveTemplateString(value, row) : value,
    ]),
  );
}

function dispatchEntityListActionEvent<TData>(detail: ActionEventDetail<TData>) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(ENTITY_LIST_ACTION_EVENT, {
      detail,
    }),
  );
}

/**
 * Build the canonical action list from `rowActions` + `actionDefinitions`,
 * falling back to the legacy direct `actions` array when no rowAction config
 * is supplied. Exposed for tests and for features that want to resolve
 * actions without a column wrapper.
 */
export function resolveEntityListActions(
  options: Pick<
    CreateActionsColumnOptions<Record<string, unknown>>,
    "actions" | "actionDefinitions" | "rowActions" | "routes" | "lang"
  >,
): EntityListAction[] {
  const { actions, actionDefinitions, rowActions, routes, lang } = options;

  if (rowActions?.length) {
    return rowActions.flatMap((rowAction) => {
      const definition = actionDefinitions?.[rowAction.actionRef];
      if (!definition) return [];

      const routeTemplate = definition.route
        ? (routes?.[definition.route] ?? definition.route)
        : undefined;

      return [
        {
          key: rowAction.actionRef,
          label:
            resolveLocalizedText(
              rowAction.label ?? definition.label,
              rowAction.actionRef,
              lang,
            ) ?? rowAction.actionRef,
          icon: rowAction.icon ?? definition.icon,
          hrefTemplate:
            typeof routeTemplate === "string"
              ? routeTemplate
              : resolveLocalizedText(routeTemplate, definition.route, lang),
          mutation: definition.mutation,
          targetRef: definition.targetRef,
          surface: definition.surface,
          inputRef: definition.inputRef,
          payload: {
            ...(definition.payload ?? {}),
            ...(rowAction.payload ?? {}),
          },
          confirm: resolveLocalizedText(
            rowAction.confirm ?? definition.confirm,
            undefined,
            lang,
          ),
          tone: rowAction.tone ?? definition.tone,
          visibleWhen: rowAction.visibleWhen,
          disabledWhen: rowAction.disabledWhen,
          disabledMessage: resolveLocalizedText(
            rowAction.disabledMessage,
            undefined,
            lang,
          ),
          variant:
            (rowAction.tone ?? definition.tone) === "destructive"
              ? "destructive"
              : "default",
        },
      ];
    });
  }

  return actions ?? [];
}

export function createActionsColumn<TData extends Record<string, unknown>>(
  options: CreateActionsColumnOptions<TData>,
): ColumnDef<TData> {
  const {
    lang,
    onAction,
    triggerLabel = lang === "nl" ? "Rij acties" : "Row actions",
    headerLabel = lang === "nl" ? "Acties" : "Actions",
  } = options;

  const resolvedActions = resolveEntityListActions({
    actions: options.actions,
    actionDefinitions: options.actionDefinitions,
    rowActions: options.rowActions,
    routes: options.routes,
    lang,
  });

  const handleClick = (action: EntityListAction, row: TData) => {
    if (action.confirm && typeof window !== "undefined") {
      if (!window.confirm(action.confirm)) return;
    }
    const payload = resolvePayload(action.payload, row as Record<string, unknown>);
    const detail: ActionEventDetail<TData> = { action, row, payload };
    if (onAction) {
      onAction(detail);
    } else {
      dispatchEntityListActionEvent(detail);
    }
  };

  return {
    id: "actions",
    header: () => createElement("span", { className: "sr-only" }, headerLabel),
    enableSorting: false,
    enableHiding: false,
    cell: ({ row }) => {
      const original = row.original;
      const perRow: TableRowAction[] = resolvedActions
        .filter((action) =>
          matchesVisibility(action.visibleWhen, original as Record<string, unknown>),
        )
        .map((action) => {
          const disabled = action.disabledWhen
            ? matchesVisibility(action.disabledWhen, original as Record<string, unknown>)
            : false;
          return {
            key: action.key,
            label: action.label,
            icon: action.icon,
            disabled,
            disabledMessage: disabled ? action.disabledMessage : undefined,
            tone: action.tone,
            onClick: () => handleClick(action, original),
          };
        });

      return createElement(TableRowActionsMenu, {
        actions: perRow,
        triggerLabel,
      });
    },
    meta: {
      headerClassName: "w-12",
      cellClassName: "w-12",
    },
  };
}
