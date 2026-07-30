// SPDX-License-Identifier: BUSL-1.1
import type { ReactNode } from "react";
import { BodyHeader } from "@/components/ui/layout/body-header";
import { EntityPageChrome } from "@/components/entity/EntityPageChrome";
import { WorkspaceListClient } from "@/components/entity/WorkspaceListClient";
import { WorkspaceRelatedPane } from "@/components/entity/WorkspaceRelatedPane";
import { EntityActionButtons } from "@/features/entity-actions/components/EntityActionButtons";
import {
  detailConfigToRendererDefinition,
  detailPaneToRendererDefinition,
  translateDetailText,
} from "@/components/entity/entity-detail-contract";
import { Renderer } from "@/features/renderer/components/renderer";
import { t } from "@/lib/server-context";
import type { EntityManifestEntry } from "@/compiler/entity-manifest";
import { resolveListSort } from "./data-loaders";
import { WorkspaceEmptyState } from "./workspace-empty-state";
import type { WorkspaceColumn, WorkspaceListData, WorkspaceSearchParams } from "./types";

export function buildColumn(
  content: ReactNode,
  pane?: {
    defaultWidth?: number;
    minWidth?: number;
    maxWidth?: number;
    weight?: number;
  },
): WorkspaceColumn {
  const size =
    pane?.defaultWidth !== undefined
      ? pane.defaultWidth
      : (`${pane?.weight ?? 1}fr` as const);

  return {
    content,
    size,
    min: pane?.minWidth,
    max: pane?.maxWidth,
  };
}

export function buildListColumn({
  entry,
  config,
  lang,
  rows,
  listData,
  listLoadError,
  rowLink,
  workspaceTitle,
  tableId,
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
}) {
  return buildColumn(
    listLoadError ? (
      <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-800 dark:border-yellow-900/50 dark:bg-yellow-900/10 dark:text-yellow-200">
        {listLoadError}
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
    ),
    config.list,
  );
}

export function buildBodyColumn({
  entry,
  config,
  lang,
  entity,
  detailHeader,
  detailLoadError,
  activeActions,
  activeGroupId,
  listRoute,
  searchParams,
}: {
  entry: EntityManifestEntry;
  config: any;
  lang: string;
  entity: Record<string, unknown> | null;
  detailHeader: any;
  detailLoadError: string | null;
  activeActions: any[];
  activeGroupId: string;
  listRoute: string;
  searchParams: WorkspaceSearchParams;
}) {
  return buildColumn(
    entity ? (
      <EntityPageChrome
        header={{
          ...detailHeader,
          badges: entry.domains.length
            ? [...entry.domains, ...((detailHeader as any).badges ?? [])]
            : (detailHeader as any).badges,
        }}
        notice={detailLoadError ? { tone: "warning", message: detailLoadError } : undefined}
        headerExtra={activeActions.length > 0 ? (
          <EntityActionButtons activeActions={activeActions} entityState={entity ?? {}} />
        ) : null}
        className="max-w-none gap-6 pt-0"
      >
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
      </EntityPageChrome>
    ) : (
      <WorkspaceEmptyState
        title={lang === "nl" ? "Geen taak geselecteerd" : "No task selected"}
        description={lang === "nl"
          ? "Selecteer een taak uit de lijst om de details en gerelateerde context te bekijken."
          : "Select a task from the list to inspect its details and related context."}
      />
    ),
    config.body,
  );
}

export function buildRelatedColumn({ entry, config, lang, entity }: {
  entry: EntityManifestEntry;
  config: any;
  lang: string;
  entity: Record<string, unknown> | null;
}) {
  return config.related
    ? buildColumn(
        entity ? (
          <WorkspaceRelatedPane
            entity={entity}
            lang={lang}
            config={config.related}
            persistTaskOutput={entry.entityName === "Task"}
          />
        ) : (
          <WorkspaceEmptyState
            title={lang === "nl" ? "Geen context beschikbaar" : "No related context yet"}
            description={lang === "nl"
              ? "Gerelateerde informatie verschijnt zodra een taak is geselecteerd."
              : "Related information appears once a task has been selected."}
          />
        ),
        config.related,
      )
    : undefined;
}

export function buildSidebarColumn({ config, lang, entity }: {
  config: any;
  lang: string;
  entity: Record<string, unknown> | null;
}) {
  return config.sidebar
    ? buildColumn(
        entity ? (
          <div className="space-y-4">
            {config.sidebar.title ? (
              <BodyHeader title={t(config.sidebar.title, lang)} showBackButton={false} className="space-y-0" />
            ) : null}
            <Renderer
              definition={detailPaneToRendererDefinition(config.sidebar)}
              lang={lang}
              showTitle={false}
              showDescription={false}
              initialData={entity}
            />
          </div>
        ) : (
          <WorkspaceEmptyState
            title={lang === "nl" ? "Geen zijbalkcontext" : "No sidebar context yet"}
            description={lang === "nl"
              ? "Selecteer eerst een record om deze kolom te vullen."
              : "Select a record first to populate this column."}
          />
        ),
        config.sidebar,
      )
    : undefined;
}
