// SPDX-License-Identifier: BUSL-1.1
import type { ReactNode } from "react";
import type { VisibilityConfig } from "@/compiler/field-contract";
import { evaluateVisibility } from "@/features/entity-actions/lib/evaluate-visibility";

/**
 * Predicate that decides whether an entity-action `key` (e.g. "create",
 * "edit", "delete") should be visible. Returning `false` filters the action
 * out before any other visibility logic runs.
 *
 * Server callers compose this from `rolesGrantOp(...)` over the live
 * session roles; client callers pass nothing — no role gating happens. Kept
 * as a callback so this module never imports a `server-only` helper, since
 * it is also pulled into the client renderer bundle.
 */
export type EntityActionVisibilityPredicate = (actionKey: string) => boolean;

export type EntityPageHeaderAction = {
  key: string;
  label: string;
  href?: string;
  route?: string;
  mutation?: string;
  confirm?: string;
  disabled?: boolean;
  disabledMessage?: string | null;
};

export type EntityPageHeaderActionsContext = {
  entityId: string;
  baseRoute?: string;
  deleteMutationName?: string;
  lang: string;
};

export type EntityPageHeader = {
  title: ReactNode;
  subtitle?: ReactNode;
  badges?: string[];
  actions?: EntityPageHeaderAction[];
  actionsContext?: EntityPageHeaderActionsContext;
};

type LocalizedText = string | { en?: string; nl?: string } | Record<string, string> | undefined;

type ViewAction = {
  key: string;
  label?: LocalizedText;
  route?: string;
  mutation?: string;
  confirm?: LocalizedText;
  visibleWhen?: VisibilityConfig | null;
  disabledWhen?: VisibilityConfig | null;
  disabledMessage?: string | { en?: string; nl?: string } | null;
};

function translateActionText(text: LocalizedText | undefined, lang: string): string | undefined {
  if (!text) return undefined;
  if (typeof text === "string") return text;
  return text[lang as "en" | "nl"] ?? text.en ?? text.nl;
}

function resolveLocalizedRouteTemplate(
  routeMap: Record<string, unknown> | undefined,
  routeKey: string | undefined,
  lang: string,
): string | undefined {
  if (!routeMap || !routeKey) return undefined;

  const template = routeMap[routeKey];
  if (!template) return undefined;

  return typeof template === "string"
    ? template
    : typeof template === "object" && template !== null
      ? (template as Record<string, string | undefined>)[lang as "en" | "nl"]
        ?? (template as Record<string, string | undefined>).en
        ?? (template as Record<string, string | undefined>).nl
      : undefined;
}

function stripTrailingDynamicSegment(path: string): string {
  return path.replace(/\/:[^/]+$/, "");
}

function normalizeGeneratedRouteHref(
  routeMap: Record<string, unknown> | undefined,
  routeKey: string | undefined,
  lang: string,
  entityId?: string,
): string | undefined {
  if (routeKey === "create") {
    const listRoute = resolveLocalizedRouteTemplate(routeMap, "list", lang);
    if (listRoute) {
      return `${listRoute}/create`;
    }
  }

  if (routeKey === "edit") {
    const detailRoute = resolveLocalizedRouteTemplate(routeMap, "detail", lang);
    if (detailRoute && entityId) {
      return `${detailRoute.replace(":id", entityId)}/edit`;
    }
  }

  if (routeKey === "delete") {
    const detailRoute = resolveLocalizedRouteTemplate(routeMap, "detail", lang);
    if (detailRoute && entityId) {
      return `${detailRoute.replace(":id", entityId)}/delete`;
    }
  }

  return undefined;
}

function resolveRouteHref(
  routeMap: Record<string, unknown> | undefined,
  routeKey: string | undefined,
  lang: string,
  entityId?: string,
): string | undefined {
  const normalizedHref = normalizeGeneratedRouteHref(routeMap, routeKey, lang, entityId);
  if (normalizedHref) {
    return normalizedHref;
  }

  const href = resolveLocalizedRouteTemplate(routeMap, routeKey, lang);

  if (!href) return undefined;

  if (entityId) {
    return href.replace(":id", entityId);
  }

  if (routeKey === "create" && /\/(new|nieuw|aanmaken)$/.test(href)) {
    return `${stripTrailingDynamicSegment(href)}/create`;
  }

  return href;
}

export function resolveEntityPageActions(
  actions: readonly ViewAction[] | undefined,
  lang: string,
  options?: {
    routes?: Record<string, unknown>;
    entityId?: string;
    entity?: Record<string, unknown>;
    /**
     * When provided, actions whose `key` returns `false` are filtered out
     * before visibility/disabled evaluation. Source the predicate from
     * `lib/server/entity-action-authz.ts` to keep authoring as the truth.
     */
    isActionVisible?: EntityActionVisibilityPredicate;
  },
): EntityPageHeaderAction[] | undefined {
  const entity = options?.entity ?? {};
  const isActionVisible = options?.isActionVisible;
  const resolved = (actions ?? [])
    .filter((action) => (isActionVisible ? isActionVisible(action.key) : true))
    .filter((action) => evaluateVisibility(action.visibleWhen, entity) !== false)
    .map((action) => {
      const disabledByCondition =
        action.disabledWhen != null ? evaluateVisibility(action.disabledWhen, entity) : false;
      const disabled = disabledByCondition === true ? true : undefined;
      const disabledMessage = disabled
        ? (translateActionText(action.disabledMessage ?? undefined, lang) ?? null)
        : null;
      return {
        key: action.key,
        label: translateActionText(action.label, lang) ?? action.key,
        href: resolveRouteHref(options?.routes, action.route, lang, options?.entityId),
        mutation: action.mutation,
        confirm: translateActionText(action.confirm, lang),
        ...(disabled !== undefined ? { disabled } : {}),
        ...(disabledMessage ? { disabledMessage } : {}),
      };
    })
    .filter((action) => Boolean(action.href || action.mutation));

  return resolved.length ? resolved : undefined;
}
