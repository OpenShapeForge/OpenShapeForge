// SPDX-License-Identifier: BUSL-1.1
import {
  formatEntityDisplayValue,
  getNestedEntityValue,
  translateEntityText,
  type EntityFieldConfig,
  type LocalizedText,
} from "./entity-field-contract";
import {
  resolveEntityPageActions,
  type EntityPageHeader,
} from "./entity-page-contract";
import type { Field } from "@/generated/compiler/field-contract";
import type {
  FormGroupInterpretation,
  RendererChildRelationshipUsage,
  RendererFieldDisplayMode,
  RendererFormDefinition,
  RendererFormGroup,
  RendererRelationshipUsage,
} from "@/features/renderer/form-definition";

export type ViewAction = {
  key: string;
  label?: LocalizedText;
  route?: string;
  mutation?: string;
  confirm?: LocalizedText;
};

export type DetailTimelineInclude =
  | "self"
  | { relationship: string };

export type DetailTimelineConfig = {
  include?: DetailTimelineInclude[];
};

export type DetailGroup = {
  id: string;
  title?: LocalizedText;
  /** Compiler-emitted flag — suppresses the card title when it would duplicate the sole field's label. */
  hideGroupTitle?: boolean;
  label?: LocalizedText;
  render?: string;
  fields?: string[];
  relationships?: {
    name: string;
    view?: string;
    presentationType?: "list" | "cards" | "summary" | "listItem";
    titleField?: string;
    subtitleField?: string;
    title?: LocalizedText;
    emptyState?: LocalizedText;
    actions?: ViewAction[];
    itemActions?: ViewAction[];
    routes?: Record<string, LocalizedText | string>;
    fields?: DetailFieldConfig[];
    childRelationships?: ChildRelationshipConfig[];
  }[];
  relationship?: {
    name: string;
    view?: string;
    presentationType?: "list" | "cards" | "summary" | "listItem";
    titleField?: string;
    subtitleField?: string;
    title?: LocalizedText;
    emptyState?: LocalizedText;
    actions?: ViewAction[];
    itemActions?: ViewAction[];
    routes?: Record<string, LocalizedText | string>;
    fields?: DetailFieldConfig[];
    childRelationships?: ChildRelationshipConfig[];
    overrides?: {
      title?: LocalizedText;
      emptyState?: LocalizedText;
    };
  };
  groups?: DetailGroup[];
  timeline?: DetailTimelineConfig;
};

export type DetailFieldConfig = Pick<
  EntityFieldConfig,
  "key" | "label" | "render" | "options" | "semanticType"
> & {
  valueType?: Field["valueType"];
  cardinality?: Field["cardinality"];
  /** Omit label row in detail/workspace panes (merged into {@link RendererFieldConfig.hideLabel}). */
  hideLabel?: boolean;
  /** Optional per-field display mode (e.g. hidden hydration field for workspace related panes). */
  fieldDisplayMode?: RendererFieldDisplayMode;
  /** Compiler-emitted sibling-field pointer for variable suggestions (mirrors edit mode). */
  suggestions?: { sourceField?: string };
  /** Column-span hint (e.g. `1` for full-width) consumed by the renderer's layout policy. */
  layoutFraction?: number;
  children?: DetailFieldConfig[];
  item?: DetailFieldConfig;
};

/** Raw page-config shape for a nested embedded relationship (lazy-fetched). */
export type ChildRelationshipConfig = {
  name: string;
  view?: string;
  entitySlug: string;
  listQueryName?: string;
  filterField: string;
  pageSize?: number;
  sort?: { key: string; direction: "asc" | "desc" };
  lazy?: "onExpand";
  presentationType?: "list" | "cards" | "summary" | "listItem";
  titleField?: string;
  subtitleField?: string;
  title?: LocalizedText;
  emptyState?: LocalizedText;
  routes?: Record<string, LocalizedText | string>;
  fields?: DetailFieldConfig[];
};

export type DetailConfig = {
  render?: string;
  queryName?: string;
  header: {
    titleTemplate: string;
    subtitleTemplate?: string;
    badges?: string[];
  };
  actions?: ViewAction[];
  groups: DetailGroup[];
  routes?: Record<string, LocalizedText | string>;
  fields?: DetailFieldConfig[];
  deleteMutationName?: string;
  listRoute?: LocalizedText | string;
};

type DetailRendererDefinitionOptions = {
  id?: string;
  surface?: NonNullable<RendererFormDefinition["presentation"]>["surface"];
  layoutColumns?: 1 | 2 | 3 | 4;
  groupInterpretation?: readonly FormGroupInterpretation[];
  chrome?: NonNullable<RendererFormDefinition["presentation"]>["chrome"];
  metadata?: Record<string, unknown>;
};

function inferRendererFieldValueType(field: DetailFieldConfig | undefined): Field["valueType"] {
  switch (field?.render?.component) {
    case "DatePicker":
      return "date";
    case "DateTimePicker":
      return "datetime";
    case "NumberInput":
      return "number";
    case "Switch":
    case "Checkbox":
      return "boolean";
    default:
      return "string";
  }
}

function mapRelationshipField(field: DetailFieldConfig) {
  return {
    ...field,
    render: field.render?.component
      ? {
          component: field.render.component,
          ...(field.render.props ? { props: field.render.props } : {}),
        }
      : undefined,
    options: field.options?.type ? (field.options as Field["options"]) : undefined,
  };
}

function mapChildRelationship(child: ChildRelationshipConfig): RendererChildRelationshipUsage {
  return {
    name: child.name,
    view: child.view,
    entitySlug: child.entitySlug,
    listQueryName: child.listQueryName,
    filterField: child.filterField,
    pageSize: child.pageSize,
    sort: child.sort,
    lazy: child.lazy,
    presentationType: child.presentationType,
    titleField: child.titleField,
    subtitleField: child.subtitleField,
    title: child.title,
    emptyState: child.emptyState,
    fields: child.fields?.map(mapRelationshipField),
  };
}

function mapRelationshipUsage(
  relationship: NonNullable<DetailGroup["relationships"]>[number] | NonNullable<DetailGroup["relationship"]>,
): RendererRelationshipUsage {
  return {
    name: relationship.name,
    view: relationship.view,
    presentationType: "presentationType" in relationship ? relationship.presentationType : undefined,
    titleField: "titleField" in relationship ? relationship.titleField : undefined,
    subtitleField: "subtitleField" in relationship ? relationship.subtitleField : undefined,
    title: ("overrides" in relationship ? relationship.overrides?.title : undefined) ?? ("title" in relationship ? relationship.title : undefined),
    emptyState: ("overrides" in relationship ? relationship.overrides?.emptyState : undefined) ?? ("emptyState" in relationship ? relationship.emptyState : undefined),
    actions: "actions" in relationship ? relationship.actions : undefined,
    itemActions: "itemActions" in relationship ? relationship.itemActions : undefined,
    routes: "routes" in relationship ? relationship.routes : undefined,
    fields: "fields" in relationship ? relationship.fields?.map(mapRelationshipField) : undefined,
    childRelationships: "childRelationships" in relationship
      ? relationship.childRelationships?.map(mapChildRelationship)
      : undefined,
  };
}

function mapGroup(group: DetailGroup): RendererFormGroup {
  return {
    id: group.id,
    title: group.label ?? group.title,
    hideGroupTitle: group.hideGroupTitle,
    fields: group.fields ?? [],
    groups: group.groups?.map(mapGroup) ?? [],
    relationships: group.relationships?.map(mapRelationshipUsage),
    relationship: group.relationship ? mapRelationshipUsage(group.relationship) : undefined,
    render: group.render,
    timeline: group.timeline
      ? {
          include: group.timeline.include?.map((entry) =>
            entry === "self" ? "self" : { relationship: entry.relationship },
          ),
        }
      : undefined,
  };
}

export function translateDetailText(
  text: LocalizedText | string | null,
  lang: string,
): string {
  return translateEntityText(text, lang);
}

/**
 * Keeps the detail authoring contract as the source of truth while projecting
 * it into the canonical renderer tree used by the new runtime.
 */
function createRendererDefinitionFromDetailGroups(
  groups: DetailGroup[],
  fieldsConfig: DetailFieldConfig[],
  options: DetailRendererDefinitionOptions = {},
): RendererFormDefinition {
  const fields: Field[] = fieldsConfig.map(mapDetailFieldToRendererField);

  return {
    schemaVersion: 1,
    id: options.id ?? "entity-detail",
    kind: "form",
    mode: "display",
    metadata: options.metadata,
    presentation: {
      surface: options.surface ?? "page",
      density: "default",
      layout: {
        columns: options.layoutColumns ?? 2,
      },
      groupInterpretation: options.groupInterpretation ?? ["tab", "card", "group"],
      chrome: {
        showTitle: false,
        showDescription: false,
        showGroupTitles: true,
        showGroupDescriptions: true,
        showActionBar: false,
        ...(options.chrome ?? {}),
      },
    },
    groups: groups.map(mapGroup),
    fields,
    fieldConfig: Object.fromEntries(
      fieldsConfig.map((field) => [
        field.key,
        {
          dataPath: field.key,
          ...(field.hideLabel ? { hideLabel: true as const } : {}),
          ...(field.fieldDisplayMode ? { displayMode: field.fieldDisplayMode } : {}),
        },
      ]),
    ),
  };
}

function mapDetailFieldToRendererField(field: DetailFieldConfig): Field {
  return {
    key: field.key,
    valueType: field.valueType ?? inferRendererFieldValueType(field),
    cardinality: field.cardinality,
    label: field.label,
    semanticType: field.semanticType,
    layoutFraction: field.layoutFraction,
    render: field.render?.component ? {
      component: field.render.component,
      ...(field.render.props ? { props: field.render.props } : {}),
    } : undefined,
    options: field.options?.type ? (field.options as Field["options"]) : undefined,
    suggestions: field.suggestions,
    children: field.children?.map(mapDetailFieldToRendererField),
    item: field.item ? mapDetailFieldToRendererField(field.item) : undefined,
  };
}

export function detailConfigToRendererDefinition(
  config: DetailConfig,
  options: DetailRendererDefinitionOptions = {},
): RendererFormDefinition {
  return createRendererDefinitionFromDetailGroups(config.groups, config.fields ?? [], {
    ...options,
    metadata: {
      ...options.metadata,
      ...(config.queryName ? { queryName: config.queryName } : {}),
    },
  });
}

export function detailPaneToRendererDefinition(
  pane: {
    groups: DetailGroup[];
    fields?: DetailFieldConfig[];
  },
  options: DetailRendererDefinitionOptions = {},
): RendererFormDefinition {
  return createRendererDefinitionFromDetailGroups(
    pane.groups,
    pane.fields ?? [],
    {
      id: "entity-detail-pane",
      surface: "workspace",
      layoutColumns: 1,
      groupInterpretation: ["card", "group", "group"],
      chrome: {
        showTitle: false,
        showDescription: false,
        showGroupTitles: true,
        showGroupDescriptions: true,
        showActionBar: false,
      },
      ...options,
    },
  );
}

export function getDetailField(
  config: DetailConfig,
  key: string,
): DetailFieldConfig | undefined {
  return config.fields?.find((field) => field.key === key);
}

export function formatDetailPrimitiveValue(value: unknown, lang: string): string {
  return formatEntityDisplayValue(undefined, value, lang);
}

export function formatDetailFieldValue(
  field: DetailFieldConfig | undefined,
  value: unknown,
  lang: string,
): string {
  return formatEntityDisplayValue(field, value, lang);
}

export function resolveEntityTemplate(
  template: string | undefined,
  entity: Record<string, unknown>,
  lang: string,
  config?: DetailConfig,
): string {
  if (!template) return "";

  return template
    .replace(/\{\{(.+?)\}\}/g, (_, expression: string) => {
      for (const candidate of expression.split("||").map((part: string) => part.trim())) {
        const value = getNestedEntityValue(entity, candidate);
        if (value != null && value !== "") {
          const field = config ? getDetailField(config, candidate) : undefined;
          return formatDetailFieldValue(field, value, lang);
        }
      }
      return "";
    })
    .trim();
}

export function resolveDetailHeader(
  config: DetailConfig,
  entity: Record<string, unknown>,
  id: string,
  lang: string,
): { title: string; subtitle?: string } {
  const title = resolveEntityTemplate(config.header.titleTemplate, entity, lang, config) || id;
  const description = resolveEntityTemplate("{{description}}", entity, lang, config);
  const subtitle = description || resolveEntityTemplate(config.header.subtitleTemplate, entity, lang, config);
  const normalizedSubtitle = subtitle && subtitle !== title ? subtitle : undefined;

  return {
    title,
    subtitle: normalizedSubtitle,
  };
}

export function resolveDetailPageHeader(
  config: DetailConfig,
  entity: Record<string, unknown>,
  id: string,
  lang: string,
  isActionVisible?: (actionKey: string) => boolean,
): EntityPageHeader {
  const header = resolveDetailHeader(config, entity, id, lang);
  const badges = (config.header.badges ?? [])
    .map((badgeKey) => {
      const field = getDetailField(config, badgeKey);
      const value = getNestedEntityValue(entity, badgeKey);

      if (value == null || value === "") {
        return null;
      }

      return formatDetailFieldValue(field, value, lang);
    })
    .filter((value): value is string => Boolean(value));
  return {
    ...header,
    badges: badges.length ? badges : undefined,
    actions: resolveEntityPageActions(config.actions, lang, {
      routes: config.routes,
      entityId: id,
      entity,
      isActionVisible,
    }),
    actionsContext: {
      entityId: id,
      baseRoute: translateDetailText(config.listRoute ?? null, lang) || undefined,
      deleteMutationName: config.deleteMutationName,
      lang,
    },
  };
}
