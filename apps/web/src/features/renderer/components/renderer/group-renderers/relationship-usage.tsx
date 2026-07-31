// SPDX-License-Identifier: BUSL-1.1
import type { ReactNode } from "react";
import { resolveEntityPageActions } from "@/components/entity/entity-page-contract";
import {
  RelationshipCards,
  RelationshipList,
} from "@/features/renderer/display";
import type { Field } from "@/generated/compiler/field-contract";
import { renderDisplayField } from "@/features/renderer/components/renderer/field-content";
import type { RendererRelationshipUsage } from "@/features/renderer/form-definition";
import type { LoadChildren } from "@/features/renderer/display/relationship-list-child-section";
import { translateRendererText } from "@/features/renderer/runtime/field-utils";
import {
  getValueAtPath,
  parseRendererPath,
} from "@/features/renderer/runtime/path-utils";
import { cn } from "@/lib/utils";
import type { GroupRenderContext } from "./types";

function caseStepActionTarget(
  action: Record<string, unknown>,
  item: Record<string, unknown>,
) {
  const workflow =
    typeof action.workflow === "object" && action.workflow !== null
      ? action.workflow as Record<string, unknown>
      : null;
  const workflowDefinitionId =
    typeof workflow?.workflowDefinitionId === "string" && workflow.workflowDefinitionId.trim()
      ? workflow.workflowDefinitionId
      : null;

  if (workflowDefinitionId) {
    return `/workflow-designer/${encodeURIComponent(workflowDefinitionId)}`;
  }

  const itemId = typeof item.id === "string" && item.id.trim() ? item.id : null;

  if (action.kind === "task" && itemId) {
    return `/case-step-templates/${encodeURIComponent(itemId)}/edit`;
  }

  return null;
}

function renderCaseStepActionsSummary(
  value: unknown,
  lang: string,
  item: Record<string, unknown>,
): ReactNode | null {
  if (!Array.isArray(value)) return null;

  const actions = value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );

  if (actions.length === 0) {
    return <span className="text-muted-foreground">-</span>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((action, index) => {
        const kind = typeof action.kind === "string" ? action.kind : "action";
        const key = typeof action.key === "string" ? action.key : `${kind}_${index + 1}`;
        const taskTemplate =
          typeof action.taskTemplate === "object" && action.taskTemplate !== null
            ? action.taskTemplate as Record<string, unknown>
            : null;
        const actionLabel =
          typeof action.label === "string" && action.label.trim()
            ? action.label
            : null;
        const label =
          actionLabel ??
          (typeof taskTemplate?.title === "string" && taskTemplate.title.trim()
            ? taskTemplate.title
            : key.replace(/\.(workflow|task)$/u, "").replaceAll("_", " "));
        const kindLabel = kind === "workflow"
          ? (lang === "nl" ? "Workflow" : "Workflow")
          : (lang === "nl" ? "Taak" : "Task");
        const href = caseStepActionTarget(action, item);
        const content = (
          <>
            <span className="shrink-0 font-medium text-muted-foreground">{kindLabel}</span>
            <span className="min-w-0 truncate">{label}</span>
          </>
        );
        const className =
          "inline-flex max-w-full items-center gap-1 rounded-md border border-border-subtle bg-muted/30 px-2 py-1 text-xs leading-5 text-foreground";

        if (href) {
          const actionLabel = kind === "workflow"
            ? (lang === "nl" ? `Open workflow ${label}` : `Open workflow ${label}`)
            : (lang === "nl" ? `Bewerk taak ${label}` : `Edit task ${label}`);

          return (
            <a
              key={`${key}-${index}`}
              aria-label={actionLabel}
              className={cn(
                className,
                "transition-colors hover:border-border hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
              href={href}
              title={`${kindLabel}: ${label}`}
            >
              {content}
            </a>
          );
        }

        return (
          <span
            key={`${key}-${index}`}
            className={className}
            title={`${kindLabel}: ${label}`}
          >
            {content}
          </span>
        );
      })}
    </div>
  );
}

/**
 * Lazily fetches a child relationship's rows for one parent row, scoped to the
 * parent id via `childRel.filterField`. The GraphQL list query is built
 * server-side from the core-entity registry by the
 * `/api/renderer/child-relationship` route, keeping the call authenticated and
 * tenant-filtered. Cursor pagination flows through `after`.
 */
const loadChildren: LoadChildren = async (childRel, parentId, after) => {
  const fieldKeys = (childRel.fields ?? []).map((field) => field.key);

  const response = await fetch("/api/renderer/child-relationship", {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({
      entitySlug: childRel.entitySlug,
      listQueryName: childRel.listQueryName,
      filterField: childRel.filterField,
      parentId,
      sort: childRel.sort
        ? { key: childRel.sort.key, direction: childRel.sort.direction }
        : undefined,
      pageSize: childRel.pageSize,
      after,
      fieldKeys,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to load child relationship "${childRel.name}" (${response.status}).`,
    );
  }

  const data = (await response.json()) as {
    items?: Record<string, unknown>[];
    endCursor?: string | null;
    hasNextPage?: boolean;
  };

  return {
    items: Array.isArray(data.items) ? data.items : [],
    endCursor: data.endCursor ?? null,
    hasNextPage: Boolean(data.hasNextPage),
  };
};

export function renderRelationshipUsage(
  ctx: GroupRenderContext,
  relationship: RendererRelationshipUsage,
  key: string,
) {
  const rawValue = getValueAtPath(ctx.structuredValues, parseRendererPath(relationship.name));
  // belongsTo relationships return a single object; hasMany returns an array.
  // Normalize to an array of records so both render through the same code path.
  const items = Array.isArray(rawValue)
    ? rawValue.filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    )
    : (typeof rawValue === "object" && rawValue !== null
      ? [rawValue as Record<string, unknown>]
      : []);
  const title = translateRendererText(relationship.title, ctx.lang) || relationship.name;
  const emptyState = translateRendererText(relationship.emptyState, ctx.lang) || undefined;
  const actions = resolveEntityPageActions(relationship.actions, ctx.lang, {
    routes: relationship.routes,
  })?.filter((action) => Boolean(action.href));
  const resolveItemActions = (item: Record<string, unknown>) => {
    const id = typeof item.id === "string" ? item.id : undefined;

    return resolveEntityPageActions(relationship.itemActions, ctx.lang, {
      routes: relationship.routes,
      entityId: id,
      entity: item,
    })?.filter((action) => Boolean(action.href || action.mutation));
  };
  const handleAction = (action: NonNullable<typeof actions>[number]) => {
    if (!action.href || typeof window === "undefined") {
      return;
    }

    window.location.assign(action.href);
  };

  if (relationship.presentationType === "cards" || relationship.view === "cards") {
    return (
      <RelationshipCards
        key={key}
        items={items}
        lang={ctx.lang}
        title={title}
        emptyState={emptyState}
        actions={actions}
        onAction={handleAction}
      />
    );
  }

  return (
    <RelationshipList
      key={key}
      items={items}
      lang={ctx.lang}
      title={title}
      emptyState={emptyState}
      actions={actions}
      onAction={handleAction}
      presentationType={relationship.presentationType}
      titleField={relationship.titleField}
      subtitleField={relationship.subtitleField}
      resolveItemActions={resolveItemActions}
      fields={relationship.fields ? [...relationship.fields] : undefined}
      childRelationships={
        relationship.childRelationships
          ? [...relationship.childRelationships]
          : undefined
      }
      onLoadChildren={
        relationship.childRelationships?.length ? loadChildren : undefined
      }
      renderFieldValue={(item, field, value) => {
        if (field.key === "actions") {
          const summary = renderCaseStepActionsSummary(value, ctx.lang, item);
          if (summary) return summary;
        }

        return renderDisplayField(
          {
            key: field.key,
            valueType: field.valueType ?? "string",
            cardinality: field.cardinality,
            label: field.label,
            semanticType: field.semanticType,
            layoutFraction: field.layoutFraction,
            render: field.render,
            validation: field.validation,
            options: field.options,
            suggestions: field.suggestions,
          } as Field,
          undefined,
          value,
          "display",
          ctx.lang,
          item,
        );
      }}
    />
  );
}
