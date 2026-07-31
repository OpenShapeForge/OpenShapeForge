// SPDX-License-Identifier: BUSL-1.1
import { NaturalPersonInboxBaseline } from "@/components/entity/NaturalPersonInboxBaseline";
import { EntityAccessDeniedView } from "@/components/entity/EntityAccessDeniedView";
import { isEntityForbiddenError } from "@/components/entity/entity-page-errors";
import { resolveEntityPageActions } from "@/components/entity/entity-page-contract";
import { resolveDetailPageHeader } from "@/components/entity/entity-detail-contract";
import { getCachedSession } from "@/lib/cached-session";
import { buildEntityActionVisibilityPredicate } from "@/lib/server/entity-action-authz";
import { t } from "@/lib/server-context";
import { readTableStateFromSearchParams } from "@/components/ui/data-table/table-state";
import {
  DEFAULT_GENERATED_LIST_FILTERS,
  buildGeneratedListFilter,
  deserializeGeneratedListFilters,
} from "@/components/entity/generated-list-filter";
import {
  buildEntityDetailRealtimeKey,
  buildEntityListRealtimeKey,
  resolveEntityRealtimeResourceType,
} from "@/features/realtime/lib/entity-resource-keys";
import type { RealtimeResourceKey } from "@/features/realtime/lib/resource-keys";
import {
  buildNaturalPersonHeaderEntity,
} from "@/components/entity/entity-workspace-page/natural-person-header";
import {
  loadWorkspaceDetailAndActions,
  loadWorkspaceList,
  loadWorkspaceSelectedEntity,
} from "@/components/entity/entity-workspace-page/data-loaders";
import {
  buildWorkspaceRowLink,
  getSingleSearchParamValue,
  resolveActiveDetailGroupId,
  resolveLocalizedRoute,
} from "@/components/entity/entity-workspace-page/search-state";
import {
  buildBodyColumn,
  buildListColumn,
  buildRelatedColumn,
  buildSidebarColumn,
} from "@/components/entity/entity-workspace-page/columns";
import {
  buildPageHeader,
  buildRealtimeRefresh,
} from "@/components/entity/entity-workspace-page/page-header";
import { renderWorkspaceLayout } from "@/components/entity/entity-workspace-page/workspace-layout";
import { renderCompactRelatedLayout } from "@/components/entity/entity-workspace-page/compact-related-layout";
import type { EntityWorkspacePageProps } from "@/components/entity/entity-workspace-page/types";

export async function EntityWorkspacePage({
  entry,
  config,
  lang,
  searchParams,
}: EntityWorkspacePageProps) {
  const requestedGroup = getSingleSearchParamValue(searchParams.group);
  const activeGroupId = resolveActiveDetailGroupId(config.body.config, requestedGroup);

  const tableId = `entity-workspace:${entry.entityName}`;
  const tableState = readTableStateFromSearchParams(searchParams, {
    tableId,
    defaultFilters: DEFAULT_GENERATED_LIST_FILTERS,
    deserializeFilters: deserializeGeneratedListFilters,
  });
  const listFilter = buildGeneratedListFilter(config.list.config, tableState);

  if (config.render === "NaturalPersonInboxBaseline") {
    let headerEntity = null;

    try {
      const entity = await loadWorkspaceSelectedEntity({
        entry,
        config,
        listFilter,
        searchParams,
      });
      headerEntity = buildNaturalPersonHeaderEntity(entity);
    } catch {
      headerEntity = null;
    }

    return <NaturalPersonInboxBaseline headerEntity={headerEntity} lang={lang} />;
  }

  const { listData, rows, listLoadError } = await loadWorkspaceList({
    entry,
    config,
    listFilter,
    lang,
  });

  if (isEntityForbiddenError(listLoadError)) {
    return (
      <EntityAccessDeniedView
        lang={lang}
        entityLabel={t(config.title ?? config.list.config.title, lang)}
      />
    );
  }

  const requestedSelection = getSingleSearchParamValue(searchParams[config.selectionParam]);
  const selectedId =
    requestedSelection
    ?? (config.defaultSelectionSource === "firstRow" ? (rows[0]?.id as string | undefined) : undefined);

  const listRoute = resolveLocalizedRoute(config.routes?.list, lang);
  const rowLink = buildWorkspaceRowLink(listRoute, config.selectionParam, activeGroupId);
  const realtimeResourceType = resolveEntityRealtimeResourceType(
    entry,
    config.body?.config ?? config.list?.config,
  );
  const realtimeResourceKeys: RealtimeResourceKey[] = [
    buildEntityListRealtimeKey(realtimeResourceType, `workspace:${config.selectionParam}`),
    ...(selectedId ? [buildEntityDetailRealtimeKey(realtimeResourceType, selectedId)] : []),
  ];

  const { detailLoadError, entity, activeActions } = await loadWorkspaceDetailAndActions({
    entry,
    config,
    selectedId,
    activeGroupId,
    lang,
  });

  const session = await getCachedSession();
  const isActionVisible = buildEntityActionVisibilityPredicate(
    session?.roles,
    entry.authoringEntitySlug,
  );
  const pageActions = resolveEntityPageActions(
    config.actions ?? config.list.config.actions,
    lang,
    { routes: config.routes ?? config.list.config.routes, isActionVisible },
  );
  const workspaceTitle = t(config.title ?? config.list.config.title, lang);
  const detailHeader = entity
    ? resolveDetailPageHeader(config.body.config, entity, selectedId!, lang)
    : null;
  const realtimeRefresh = buildRealtimeRefresh({
    realtimeResourceKeys,
    detailHeaderTitle: detailHeader?.title,
    workspaceTitle,
  });

  if (config.layout.variant === "page-header-list-body-related") {
    return renderCompactRelatedLayout({
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
    });
  }

  const pageHeader = buildPageHeader({
    entry,
    config,
    lang,
    workspaceTitle,
    pageActions,
    realtimeRefresh,
  });
  const listColumn = buildListColumn({
    entry,
    config,
    lang,
    rows,
    listData,
    listLoadError,
    rowLink,
    workspaceTitle,
    tableId,
  });
  const bodyColumn = buildBodyColumn({
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
  });
  const relatedColumn = buildRelatedColumn({ entry, config, lang, entity });
  const sidebarColumn = buildSidebarColumn({ config, lang, entity });

  return renderWorkspaceLayout(config.layout.variant, {
    pageHeader,
    sidebar: sidebarColumn,
    list: listColumn,
    body: bodyColumn,
    related: relatedColumn,
  });
}
