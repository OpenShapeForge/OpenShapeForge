// SPDX-License-Identifier: BUSL-1.1
import type { EntityManifestEntry } from "@/compiler/entity-manifest";
import { ENTITY_LIST_PAGE_SIZE, mapConnectionRows } from "@/components/entity/entity-list-rows";
import { buildGeneratedListFilter } from "@/components/entity/generated-list-filter";
import { resolveEntityLoadErrorMessage } from "@/components/entity/entity-page-errors";
import { fetchActiveActions } from "@/features/entity-actions/lib/fetch-active-actions";
import { getSingleSearchParamValue } from "./search-state";
import { naturalPersonWorkspaceHeaderQuery } from "./natural-person-header";
import type { WorkspaceListData, WorkspaceSearchParams } from "./types";

type ListFilter = ReturnType<typeof buildGeneratedListFilter>;

function resolveListSort(config: any) {
  return config.list.config.defaultSort
    ? { field: config.list.config.defaultSort.key, direction: config.list.config.defaultSort.direction }
    : undefined;
}

export async function loadWorkspaceSelectedEntity({
  entry,
  config,
  listFilter,
  searchParams,
}: {
  entry: EntityManifestEntry;
  config: any;
  listFilter: ListFilter;
  searchParams: WorkspaceSearchParams;
}): Promise<Record<string, unknown> | null> {
  let selectedId = getSingleSearchParamValue(searchParams[config.selectionParam]);

  if (!selectedId && config.defaultSelectionSource === "firstRow") {
    const listData = await entry.actions.list({
      query: config.list.config.query,
      sort: resolveListSort(config),
      first: 1,
      filter: listFilter,
    });
    const rows = mapConnectionRows(listData, config.list.config.columns);
    selectedId = rows[0]?.id as string | undefined;
  }

  if (!selectedId) {
    return null;
  }

  const entity = await entry.actions.get(selectedId, {
    query:
      config.render === "NaturalPersonInboxBaseline"
        ? naturalPersonWorkspaceHeaderQuery
        : config.body.config.queriesByGroup[config.body.config.defaultGroupId],
  });

  return entity ?? null;
}

export async function loadWorkspaceList({
  entry,
  config,
  listFilter,
  lang,
}: {
  entry: EntityManifestEntry;
  config: any;
  listFilter: ListFilter;
  lang: string;
}): Promise<{
  listData: WorkspaceListData | undefined;
  rows: Record<string, unknown>[];
  listLoadError: string | null;
}> {
  try {
    const listData = await entry.actions.list({
      query: config.list.config.query,
      sort: resolveListSort(config),
      first: ENTITY_LIST_PAGE_SIZE,
      filter: listFilter,
    });

    return {
      listData,
      rows: mapConnectionRows(listData, config.list.config.columns),
      listLoadError: null,
    };
  } catch (error) {
    return {
      listData: undefined,
      rows: [],
      listLoadError: resolveEntityLoadErrorMessage(error, lang),
    };
  }
}

export async function loadWorkspaceDetailAndActions({
  entry,
  config,
  selectedId,
  activeGroupId,
  lang,
}: {
  entry: EntityManifestEntry;
  config: any;
  selectedId: string | undefined;
  activeGroupId: string;
  lang: string;
}): Promise<{
  detailLoadError: string | null;
  entity: Record<string, unknown> | null;
  activeActions: any[];
}> {
  let detailLoadError: string | null = null;
  let entity: Record<string, unknown> | null = null;
  let activeActions: any[] = [];

  if (!selectedId) {
    return { detailLoadError, entity, activeActions };
  }

  try {
    entity = await entry.actions.get(selectedId, {
      query:
        config.queriesByBodyGroup[activeGroupId]
        ?? config.body.config.queriesByGroup[config.body.config.defaultGroupId],
    });
  } catch (error) {
    detailLoadError = resolveEntityLoadErrorMessage(error, lang);
  }

  try {
    activeActions = await fetchActiveActions(entry.entityType, selectedId);
  } catch {
    activeActions = [];
  }

  return { detailLoadError, entity, activeActions };
}

export { resolveListSort };
