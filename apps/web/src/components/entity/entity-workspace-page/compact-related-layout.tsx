// SPDX-License-Identifier: BUSL-1.1
import type { ReactNode } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/display/badge";
import { WorkspaceBodyHeader } from "@/components/entity/WorkspaceBodyHeader";
import { WorkspaceListClient } from "@/components/entity/WorkspaceListClient";
import { WorkspaceRelatedPane } from "@/components/entity/WorkspaceRelatedPane";
import { EntityActionButtons } from "@/features/entity-actions/components/EntityActionButtons";
import { detailConfigToRendererDefinition, translateDetailText } from "@/components/entity/entity-detail-contract";
import { Renderer } from "@/features/renderer/components/renderer";
import { Button } from "@openshapeforge/ui";
import { t } from "@/lib/server-context";
import type { EntityManifestEntry } from "@/compiler/entity-manifest";
import { resolveListSort } from "./data-loaders";
import { WorkspaceBatteryLayout } from "./workspace-layout";
import { WorkspaceEmptyState } from "./workspace-empty-state";
import type { PageAction, WorkspaceListData, WorkspaceSearchParams } from "./types";

export function renderCompactRelatedLayout({
  entry,
  config,
  lang,
  rows,
  listData,
  listLoadError,
  rowLink,
  workspaceTitle,
  tableId,
  pageActions,
  entity,
  detailHeader,
  detailLoadError,
  activeActions,
  activeGroupId,
  listRoute,
  searchParams,
  realtimeRefresh,
}: {
  entry: EntityManifestEntry;
  config: any;
  lang: string;
  rows: Record<string, unknown>[];
  listData: WorkspaceListData | undefined;
  listLoadError: string | null;
  rowLink: string;
  workspaceTitle: string;
  tableId: string;
  pageActions: PageAction[] | undefined;
  entity: Record<string, unknown> | null;
  detailHeader: any;
  detailLoadError: string | null;
  activeActions: any[];
  activeGroupId: string;
  listRoute: string;
  searchParams: WorkspaceSearchParams;
  realtimeRefresh: ReactNode;
}) {
  const listHeaderActions = (pageActions ?? []).filter((a) => Boolean(a.href));
  const totalCount = listData?.totalCount ?? rows.length;

  const listColumnContent = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border/60 px-4">
        <p className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[-0.39px] text-muted-foreground">
          {workspaceTitle}
        </p>
        {!listLoadError ? <Badge variant="secondary">{totalCount}</Badge> : null}
        {listHeaderActions.map((action) => (
          <Button key={action.key} asChild size="sm" variant="outline" data-testid={`entity-action-${action.key}`}>
            <Link href={action.href!}>{action.label}</Link>
          </Button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {listLoadError ? (
          <div className="p-4">
            <p className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-800 dark:border-yellow-900/50 dark:bg-yellow-900/10 dark:text-yellow-200">
              {listLoadError}
            </p>
          </div>
        ) : (
          <WorkspaceListClient
            columns={config.list.config.columns.map((column: any) => ({ ...column, label: t(column.label, lang) }))}
            initialRows={rows}
            initialHasNextPage={Boolean(listData?.pageInfo?.hasNextPage)}
            initialEndCursor={listData?.pageInfo?.endCursor ?? null}
            initialTotalCount={listData?.totalCount ?? rows.length}
            listAction={entry.actions.list}
            listQuery={config.list.config.query}
            listSort={resolveListSort(config)}
            rowLink={rowLink}
            lang={lang}
            regionLabel={workspaceTitle}
            filters={config.list.config.filters}
            filterField={config.list.config.filterField}
            searchPlaceholder={t(config.list.config.searchPlaceholder, lang)}
            actionDefinitions={config.list.config.actionDefinitions}
            rowActions={config.list.config.rowActions}
            routes={config.list.config.routes}
            deleteMutationName={config.list.config.deleteMutationName}
            tableId={tableId}
          />
        )}
      </div>
    </div>
  );

  const bodyColumnContent = entity ? (
    <div className="flex min-h-0 flex-1 flex-col">
      <WorkspaceBodyHeader
        header={{
          ...detailHeader,
          badges: entry.domains.length
            ? [...entry.domains, ...((detailHeader as any).badges ?? [])]
            : (detailHeader as any).badges,
        }}
        notice={detailLoadError}
        extra={activeActions.length > 0 ? (
          <EntityActionButtons activeActions={activeActions} entityState={entity ?? {}} />
        ) : null}
      />
      <div className="min-h-0 flex-1 overflow-auto px-6 py-6">
        <Renderer
          definition={detailConfigToRendererDefinition(config.body.config, { surface: "workspace" })}
          lang={lang}
          showTitle={false}
          showDescription={false}
          initialData={entity}
          activeTabId={activeGroupId}
          tabNavigation={{
            pathname: listRoute,
            searchParams,
            defaultTabId: config.body.config.defaultGroupId,
            paramName: "group",
          }}
          tabAriaLabel={translateDetailText({ en: "Detail groups", nl: "Detailgroepen" }, lang)}
        />
      </div>
    </div>
  ) : (
    <WorkspaceEmptyState
      title={lang === "nl" ? "Geen item geselecteerd" : "No item selected"}
      description={lang === "nl"
        ? "Selecteer een item uit de lijst om de details en gerelateerde context te bekijken."
        : "Select an item from the list to inspect its details and related context."}
    />
  );

  const relatedColumnContent = config.related
    ? entity
      ? (
          <WorkspaceRelatedPane
            entity={entity}
            lang={lang}
            config={config.related}
            persistTaskOutput={entry.entityName === "Task"}
          />
        )
      : (
          <WorkspaceEmptyState
            title={lang === "nl" ? "Geen context beschikbaar" : "No related context yet"}
            description={lang === "nl"
              ? "Gerelateerde informatie verschijnt zodra een item is geselecteerd."
              : "Related information appears once an item has been selected."}
          />
        )
    : null;

  return (
    <>
      {realtimeRefresh}
      <WorkspaceBatteryLayout
        variant={relatedColumnContent ? "inbox-main-context" : "inbox-main"}
        left={listColumnContent}
        main={bodyColumnContent}
        right={relatedColumnContent}
        mainSize={{ minWidth: 420, weight: 1 }}
      />
    </>
  );
}
