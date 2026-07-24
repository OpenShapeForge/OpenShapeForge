// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
/**
 * View compiler — transforms UI presentation definitions into CompiledViewContext objects.
 *
 * Pipeline position: called by the main compiler after model/storage/graphql compilation.
 * Supports two input modes: inline presentations on core entity + profiles, or a
 * standalone multi-context ViewDefinition YAML file.
 *
 * Handles list, detail, form, summary, cards, and workspace presentation types. Each presentation
 * is compiled with component catalog lookups for render component resolution.
 *
 * Input:  Core entity UI config, profile UI configs, ComponentCatalog, optional ViewDefinition.
 * Output: Record<string, CompiledViewContext> — keyed by context name ("core" or a profile context).
 */
import type {
  EntityProfile,
  ComponentCatalog,
  CompiledViewRender,
  CompiledViewContext,
  CompiledFieldEntry,
  CompiledNamedPresentation,
  CompiledRelationshipUsage,
  CompiledViewGroup,
  ViewDefinition,
  FieldEntry,
  LocalizedText,
  PresentationDefinition,
  RelationshipUsage,
  DetailPresentation,
  FormPresentation,
  ListPresentation,
  SummaryPresentation,
  CardsPresentation,
  ListItemPresentation,
  WorkspacePresentation,
  WorkspaceGroupSlot,
  ViewAction,
  ViewActionDefinition,
  ViewRowAction,
} from "../types.js";
import type { LoadedArtifacts } from "../loader.js";
import {
  normalizeSingleContextPresentations,
  normalizeMultiContextPresentations,
} from "../view-normalization.js";
import {
  resolveViewGroups,
  type ResolvedViewGroup,
} from "../view-groups.js";

export function buildViews(
  coreEntity: LoadedArtifacts["coreEntity"],
  profiles: EntityProfile[],
  catalog: ComponentCatalog,
  viewDef?: ViewDefinition
): Record<string, CompiledViewContext> {
  if (viewDef) {
    return buildViewsFromDefinition(viewDef, catalog, coreEntity.description);
  }

  const views: Record<string, CompiledViewContext> = {};

  if (coreEntity.ui?.presentations) {
    views["core"] = buildViewContext(
      normalizeSingleContextPresentations(coreEntity.ui.presentations),
      coreEntity.ui.routes ?? {},
      catalog,
      coreEntity.description,
      undefined,
    );
  }

  for (const profile of profiles) {
    if (profile.ui?.presentations) {
      views[profile.profile] = buildViewContext(
        normalizeSingleContextPresentations(profile.ui.presentations),
        profile.ui.routes ?? {},
        catalog,
        profile.description ?? coreEntity.description,
        undefined,
      );
    }
  }

  return views;
}

function buildViewsFromDefinition(
  viewDef: ViewDefinition,
  catalog: ComponentCatalog,
  entityDescription?: string | LocalizedText
): Record<string, CompiledViewContext> {
  const views: Record<string, CompiledViewContext> = {};
  const normalized = normalizeMultiContextPresentations(viewDef.presentations);

  for (const [context, presentations] of Object.entries(normalized)) {
    views[context] = buildViewContext(
      presentations,
      viewDef.routes,
      catalog,
      entityDescription,
      viewDef.groupSets,
      viewDef.actions,
    );
  }

  return views;
}

function compileFields(
  fields: FieldEntry[] | undefined,
  catalog: ComponentCatalog
): (string | CompiledFieldEntry)[] {
  return (fields ?? []).map((f) => {
    if (typeof f === "string") return f;
    const hasRender = Boolean(f.render);
    const displayMode = "fieldDisplayMode" in f ? f.fieldDisplayMode : undefined;
    if (!hasRender && !displayMode) {
      return f.key;
    }
    return {
      key: f.key,
      ...(hasRender ? { renderOverride: vr(catalog, f.render!) } : {}),
      ...(displayMode ? { fieldDisplayMode: displayMode } : {}),
    };
  });
}

function compileRelationshipUsage(
  relationship: RelationshipUsage | undefined,
  catalog: ComponentCatalog
): CompiledRelationshipUsage | undefined {
  if (!relationship) return undefined;
  return {
    render: vr(catalog, "relationshipTab"),
    name: relationship.name,
    via: relationship.via,
    view: relationship.view,
    overrides: relationship.overrides,
  };
}

function vr(catalog: ComponentCatalog, element: string): CompiledViewRender {
  const def = catalog.viewDefaults[element];
  const componentName = def?.component ?? element;
  return { component: componentName };
}

function compileActions(
  actions: ViewAction[] | undefined,
  actionDefinitions?: Record<string, ViewActionDefinition> | undefined,
) {
  return actions?.map((action) => {
    // Resolve definition when actionRef is present
    const def = action.actionRef ? (actionDefinitions?.[action.actionRef] ?? {}) : {};
    return {
      key: action.key,
      label: action.label ?? (def as ViewActionDefinition).label,
      actionRef: action.actionRef,
      route: action.route ?? (def as ViewActionDefinition).route,
      mutation: action.mutation ?? (def as ViewActionDefinition).mutation,
      targetRef: action.targetRef ?? (def as ViewActionDefinition).targetRef,
      surface: action.surface ?? (def as ViewActionDefinition).surface,
      inputRef: action.inputRef ?? (def as ViewActionDefinition).inputRef,
      payload: action.payload ?? (def as ViewActionDefinition).payload,
      confirm: action.confirm ?? (def as ViewActionDefinition).confirm,
      tone: action.tone ?? (def as ViewActionDefinition).tone,
      icon: action.icon ?? (def as ViewActionDefinition).icon,
      visibleWhen: action.visibleWhen,
      disabledWhen: action.disabledWhen,
      disabledMessage: action.disabledMessage,
    };
  });
}

function compileActionDefinitions(
  definitions: Record<string, ViewActionDefinition> | undefined,
) {
  if (!definitions) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(definitions).map(([key, definition]) => [
      key,
      {
        label: definition.label,
        icon: definition.icon,
        route: definition.route,
        mutation: definition.mutation,
        targetRef: definition.targetRef,
        surface: definition.surface,
        inputRef: definition.inputRef,
        payload: definition.payload,
        confirm: definition.confirm,
        tone: definition.tone,
      },
    ]),
  );
}

function compileRowActions(rowActions: ViewRowAction[] | undefined) {
  return rowActions?.map((action) => ({
    actionRef: action.actionRef,
    label: action.label,
    icon: action.icon,
    payload: action.payload,
    confirm: action.confirm,
    tone: action.tone,
    visibleWhen: action.visibleWhen,
    disabledWhen: action.disabledWhen,
    disabledMessage: action.disabledMessage,
  }));
}

function compileGroup(
  group: ResolvedViewGroup,
  catalog: ComponentCatalog,
): CompiledViewGroup {
  return {
    id: group.id,
    title: group.title,
    label: group.label,
    icon: group.icon,
    render: group.render ? vr(catalog, group.render) : undefined,
    fields: group.fields ? compileFields(group.fields, catalog) : undefined,
    relationships: group.relationships?.map((relationship) => compileRelationshipUsage(relationship, catalog)!),
    relationship: typeof group.relationship === "string"
      ? compileRelationshipUsage({ name: group.relationship }, catalog)
      : compileRelationshipUsage(group.relationship, catalog),
    groups: group.groups?.map((child) => compileGroup(child, catalog)),
    timeline: group.timeline,
  };
}

function buildViewContext(
  presentations: Record<string, PresentationDefinition>,
  routes: Record<string, string | LocalizedText>,
  catalog: ComponentCatalog,
  defaultListSubtitle?: string | LocalizedText,
  groupSets?: ViewDefinition["groupSets"],
  actionDefinitions?: Record<string, ViewActionDefinition>,
): CompiledViewContext {
  const ctx: CompiledViewContext = {
    page: vr(catalog, "page"),
    routes,
    actionDefinitions: compileActionDefinitions(actionDefinitions),
    presentations: {},
  };

  for (const [name, presentation] of Object.entries(presentations)) {
    const compiled = compilePresentation(name, presentation, catalog, defaultListSubtitle, groupSets, actionDefinitions);
    if (!compiled) continue;

    ctx.presentations[name] = compiled;

    if (name === "list" && compiled.type === "list") {
      ctx.list = compiled;
    }
    if (name === "detail" && compiled.type === "detail") {
      ctx.detail = compiled;
    }
    if (name === "form" && compiled.type === "form") {
      ctx.form = compiled;
    }
    if (name === "workspace" && compiled.type === "workspace") {
      ctx.workspace = compiled;
    }
  }

  return ctx;
}

function compilePresentation(
  name: string,
  presentation: PresentationDefinition,
  catalog: ComponentCatalog,
  defaultListSubtitle?: string | LocalizedText,
  groupSets?: ViewDefinition["groupSets"],
  actionDefinitions?: Record<string, ViewActionDefinition>,
): CompiledNamedPresentation | null {
  switch (presentation.type) {
    case "list":
      return compileListPresentation(name, presentation as ListPresentation, catalog, defaultListSubtitle, actionDefinitions);
    case "detail":
      return compileDetailPresentation(name, presentation as DetailPresentation, catalog, groupSets, actionDefinitions);
    case "form":
      return compileFormPresentation(name, presentation as FormPresentation, catalog, groupSets, actionDefinitions);
    case "summary":
      return compileSummaryPresentation(name, presentation as SummaryPresentation, catalog, actionDefinitions);
    case "cards":
      return compileCardsPresentation(name, presentation as CardsPresentation, catalog, actionDefinitions);
    case "listItem":
      return compileListItemPresentation(name, presentation as ListItemPresentation, catalog, actionDefinitions);
    case "workspace":
      return compileWorkspacePresentation(name, presentation as WorkspacePresentation, catalog, groupSets, actionDefinitions);
    default:
      return null;
  }
}

function compileListPresentation(
  name: string,
  presentation: ListPresentation,
  catalog: ComponentCatalog,
  defaultListSubtitle?: string | LocalizedText,
  actionDefinitions?: Record<string, ViewActionDefinition>,
): CompiledNamedPresentation {
  const compiled = {
    name,
    kind: presentation.kind ?? "page",
    type: "list" as const,
    render: vr(catalog, "list"),
    search: {
      render: vr(catalog, "search"),
      placeholder: { en: "Search...", nl: "Zoeken..." },
    },
    title: presentation.title,
    subtitle: presentation.subtitle ?? toLocalizedText(defaultListSubtitle),
    columns: presentation.columns,
    defaultSort: presentation.defaultSort,
    rowLink: presentation.rowLink,
    pageSize: presentation.pageSize,
    emptyState: presentation.emptyState,
    itemAction: presentation.itemAction,
    actions: compileActions(presentation.actions, actionDefinitions),
    rowActions: compileRowActions(presentation.rowActions),
  };

  if (presentation.filters?.length) {
    return {
      ...compiled,
      filterBar: { render: vr(catalog, "filterBar"), filters: presentation.filters },
    };
  }

  return compiled;
}

function compileDetailPresentation(
  name: string,
  presentation: DetailPresentation,
  catalog: ComponentCatalog,
  groupSets?: ViewDefinition["groupSets"],
  actionDefinitions?: Record<string, ViewActionDefinition>,
): CompiledNamedPresentation {
  const groups = resolveViewGroups(
    { groups: presentation.groups },
    { groupSets, path: `presentation '${name}'` },
  );

  return {
    name,
    kind: presentation.kind ?? "page",
    type: "detail",
    render: presentation.render ? vr(catalog, presentation.render) : undefined,
    header: {
      render: vr(catalog, "header"),
      title: presentation.header.title,
      subtitle: presentation.header.subtitle,
      badges: presentation.header.badges?.length
        ? { render: vr(catalog, "badges"), items: presentation.header.badges }
        : undefined,
    },
    actions: compileActions(presentation.actions, actionDefinitions),
    groups: {
      render: vr(catalog, "tabs"),
      items: groups.map((group) => compileGroup(group, catalog)),
    },
  };
}

function compileFormPresentation(
  name: string,
  presentation: FormPresentation,
  catalog: ComponentCatalog,
  groupSets?: ViewDefinition["groupSets"],
  actionDefinitions?: Record<string, ViewActionDefinition>,
): CompiledNamedPresentation {
  return {
    name,
    kind: presentation.kind ?? "page",
    type: "form",
    actions: compileActions(presentation.actions, actionDefinitions),
    variants: Object.fromEntries(
      Object.entries(presentation.variants).map(([variantName, variant]) => [
        variantName,
        {
          title: variant.title,
          extends: variant.extends,
          groups: resolveViewGroups(
            {
              groups: variant.groups,
              groupsFrom: variant.groupsFrom,
              groupOverrides: variant.groupOverrides,
            },
            { groupSets, path: `presentation '${name}' variant '${variantName}'` },
          ).map((group) => compileGroup(group, catalog)),
          fieldOverrides: variant.fieldOverrides,
          submit: {
            render: vr(catalog, "submitButton"),
            label: {
              en: variantName === "create" ? "Create" : "Save",
              nl: variantName === "create" ? "Aanmaken" : "Opslaan",
            },
          },
        },
      ])
    ),
    // WEB-020 — Pass through authoring-declared variable sources so the
    // generator can emit them onto the form config consumed by the renderer.
    variableSources: presentation.variableSources,
  };
}

function compileSummaryPresentation(
  name: string,
  presentation: SummaryPresentation,
  catalog: ComponentCatalog,
  actionDefinitions?: Record<string, ViewActionDefinition>,
): CompiledNamedPresentation {
  return {
    name,
    kind: "embedded",
    type: "summary",
    title: presentation.title,
    fields: compileFields(presentation.fields, catalog),
    emptyState: presentation.emptyState,
    itemAction: presentation.itemAction,
    actions: compileActions(presentation.actions, actionDefinitions),
  };
}

function compileCardsPresentation(
  name: string,
  presentation: CardsPresentation,
  catalog: ComponentCatalog,
  actionDefinitions?: Record<string, ViewActionDefinition>,
): CompiledNamedPresentation {
  return {
    name,
    kind: "embedded",
    type: "cards",
    title: presentation.title,
    titleField: presentation.titleField,
    fields: compileFields(presentation.fields, catalog),
    metaFields: compileFields(presentation.metaFields, catalog),
    emptyState: presentation.emptyState,
    itemAction: presentation.itemAction,
    actions: compileActions(presentation.actions, actionDefinitions),
  };
}

function compileListItemPresentation(
  name: string,
  presentation: ListItemPresentation,
  catalog: ComponentCatalog,
  actionDefinitions?: Record<string, ViewActionDefinition>,
): CompiledNamedPresentation {
  return {
    name,
    kind: "embedded",
    type: "listItem",
    title: presentation.title,
    titleField: presentation.titleField,
    subtitleField: presentation.subtitleField,
    fields: compileFields(presentation.fields, catalog),
    emptyState: presentation.emptyState,
    actions: compileActions(presentation.actions, actionDefinitions),
  };
}

function compileWorkspaceSlotSizing(
  slot: {
    defaultWidth?: number;
    minWidth?: number;
    maxWidth?: number;
    weight?: number;
    resizable?: boolean;
  } | undefined,
) {
  return {
    defaultWidth: slot?.defaultWidth,
    minWidth: slot?.minWidth,
    maxWidth: slot?.maxWidth,
    weight: slot?.weight,
    resizable: slot?.resizable,
  };
}

function compileWorkspaceGroupSlot(
  slot: WorkspaceGroupSlot | undefined,
  catalog: ComponentCatalog,
  groupSets?: ViewDefinition["groupSets"],
) {
  if (!slot) {
    return undefined;
  }

  const groups = resolveViewGroups(
    {
      groups: slot.groups,
      groupsFrom: slot.groupsFrom,
      groupOverrides: slot.groupOverrides,
    },
    { groupSets, path: "workspace slot" },
  );

  return {
    ...compileWorkspaceSlotSizing(slot),
    title: slot.title,
    groups: groups.map((group) => compileGroup(group, catalog)),
  };
}

function compileWorkspacePresentation(
  name: string,
  presentation: WorkspacePresentation,
  catalog: ComponentCatalog,
  groupSets?: ViewDefinition["groupSets"],
  actionDefinitions?: Record<string, ViewActionDefinition>,
): CompiledNamedPresentation {
  return {
    name,
    kind: presentation.kind ?? "page",
    type: "workspace",
    render: presentation.render ? vr(catalog, presentation.render) : undefined,
    title: presentation.title,
    subtitle: presentation.subtitle,
    selectionParam: presentation.selectionParam ?? "id",
    defaultSelectionSource: presentation.defaultSelectionSource ?? "firstRow",
    actions: compileActions(presentation.actions, actionDefinitions),
    layout: {
      variant: presentation.layout?.variant ?? "page-header-list-body-related",
    },
    slots: {
      sidebar: compileWorkspaceGroupSlot(presentation.slots?.sidebar, catalog, groupSets),
      list: {
        ...compileWorkspaceSlotSizing(presentation.slots?.list),
        presentation: presentation.slots?.list?.presentation ?? "list",
      },
      body: {
        ...compileWorkspaceSlotSizing(presentation.slots?.body),
        presentation: presentation.slots?.body?.presentation ?? "detail",
      },
      related: compileWorkspaceGroupSlot(presentation.slots?.related, catalog, groupSets),
    },
  };
}

function toLocalizedText(value?: string | LocalizedText): { en: string; nl: string } | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return { en: value, nl: value };
  return {
    en: value.en ?? value.nl ?? "",
    nl: value.nl ?? value.en ?? "",
  };
}
