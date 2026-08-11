// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
import type {
  LocalizedText,
  ItemAction,
  ViewAction,
  ViewActionDefinition,
  ViewRowAction,
} from "./common.js";

export interface Relationship {
  key: string;
  kind: "belongsTo" | "hasMany" | "manyToMany";
  target: string;
  foreignKey?: string;
  /** Explicit physical FK behaviour for a belongsTo relationship. */
  onDelete?: "CASCADE" | "RESTRICT" | "SET NULL";
  via?: string;
  label?: LocalizedText;
}

export interface ListColumn {
  key: string;
  sortable?: boolean;
}

export interface ListFilter {
  key: string;
  type: string;
  param?: string;
  clearable?: boolean;
  placeholder?: string | LocalizedText;
  referentieGroep?: string;
}

export interface ListPresentation {
  kind?: "page" | "embedded";
  type?: "list";
  title?: LocalizedText;
  subtitle?: LocalizedText;
  columns: ListColumn[];
  filters?: ListFilter[];
  defaultSort?: { key: string; direction: "asc" | "desc" };
  rowLink?: string;
  pageSize?: number;
  emptyState?: LocalizedText;
  itemAction?: ItemAction;
  actions?: ViewAction[];
  rowActions?: ViewRowAction[];
}

export interface FieldRef {
  key: string;
  render?: string;
  /** Hydration-only field: included in selection + renderer state but not rendered. */
  fieldDisplayMode?: "hidden";
}

export type FieldEntry = string | FieldRef;

export interface RelationshipOverrides {
  columns?: ListColumn[] | string[];
  fields?: FieldEntry[];
  pageSize?: number;
  sort?: { key: string; direction: "asc" | "desc" };
  title?: LocalizedText;
  emptyState?: LocalizedText;
  itemAction?: ItemAction;
}

export interface RelationshipUsage {
  name: string;
  via?: string;
  view?: string;
  overrides?: RelationshipOverrides;
}

/**
 * Per-view declaration of which sources contribute events to a timeline group.
 *
 * `"self"` always pulls the subject entity's own events. Additional entries
 * name a relationship key on the subject entity; the timeline resolver expands
 * those relationships at query time using SQL `exists` filters (no write-time
 * fan-out). Validated against compiled relationships during view compilation.
 */
export type TimelineInclude =
  | "self"
  | {
      relationship: string;
    };

export interface TimelineConfig {
  include?: TimelineInclude[];
}

export interface ViewGroupOverride {
  title?: LocalizedText;
  label?: LocalizedText;
  icon?: string;
  render?: string;
  fields?: FieldEntry[];
  relationships?: RelationshipUsage[];
  relationship?: string | RelationshipUsage;
  groups?: ViewGroup[];
  groupsFrom?: string;
  groupOverrides?: Record<string, ViewGroupOverride>;
  timeline?: TimelineConfig;
}

export interface ViewGroup {
  id?: string;
  title?: LocalizedText;
  label?: LocalizedText;
  icon?: string;
  render?: string;
  fields?: FieldEntry[];
  relationships?: RelationshipUsage[];
  relationship?: string | RelationshipUsage;
  groups?: ViewGroup[];
  groupsFrom?: string;
  groupOverrides?: Record<string, ViewGroupOverride>;
  timeline?: TimelineConfig;
}

export interface DetailPresentation {
  kind?: "page";
  type?: "detail";
  render?: string;
  header: {
    title: string;
    subtitle?: string;
    badges?: string[];
  };
  actions?: ViewAction[];
  groups?: ViewGroup[];
}

export interface FormVariant {
  title: LocalizedText;
  extends?: string;
  groups?: ViewGroup[];
  groupsFrom?: string;
  groupOverrides?: Record<string, ViewGroupOverride>;
  fieldOverrides?: Record<string, Record<string, unknown>>;
}

/**
 * WEB-020 — Declarative variable-source reference on a form presentation.
 *
 * The renderer resolves each source once per form mount and exposes the result
 * to fields that opt in via `field.suggestions.sourceKey`.
 */
export interface FormVariableSource {
  /** Stable key used by fields to opt in (e.g. "templateParameters"). */
  key: string;
  /** Identifier of a resolver registered in the web-client registry. */
  resolver: "chips" | "entityFields" | "templateParameters" | "workflowGraphVariables";
  /** Resolver-specific parameters; each resolver narrows this internally. */
  params?: Record<string, unknown>;
}

export interface FormPresentation {
  kind?: "page";
  type?: "form";
  variants: Record<string, FormVariant>;
  actions?: ViewAction[];
  /**
   * WEB-020 — Form-level declarations consumed by the web-client variable
   * source registry. Emitted verbatim onto the generated form config and the
   * `RendererFormDefinition`.
   */
  variableSources?: FormVariableSource[];
}

export interface SummaryPresentation {
  kind?: "embedded";
  type?: "summary";
  title?: LocalizedText;
  fields: FieldEntry[];
  emptyState?: LocalizedText;
  itemAction?: ItemAction;
  actions?: ViewAction[];
}

export interface CardsPresentation {
  kind?: "embedded";
  type?: "cards";
  title?: LocalizedText;
  titleField?: string;
  fields?: FieldEntry[];
  metaFields?: FieldEntry[];
  emptyState?: LocalizedText;
  itemAction?: ItemAction;
  actions?: ViewAction[];
}

export interface ListItemPresentation {
  kind?: "embedded";
  type?: "listItem";
  title?: LocalizedText;
  titleField: string;
  subtitleField?: string;
  fields?: FieldEntry[];
  emptyState?: LocalizedText;
  actions?: ViewAction[];
}

export type WorkspaceLayoutVariant =
  | "body"
  | "page-header-body"
  | "sidebar-body"
  | "page-header-list-body"
  | "page-header-list-body-related"
  | "sidebar-page-body"
  | "sidebar-page-header-list-body"
  | "sidebar-page-header-list-body-related";

export interface WorkspacePaneSizing {
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  weight?: number;
  resizable?: boolean;
}

export interface WorkspacePresentationSlot extends WorkspacePaneSizing {
  presentation?: string;
}

export interface WorkspaceGroupSlot extends WorkspacePaneSizing {
  title?: LocalizedText;
  groups?: ViewGroup[];
  groupsFrom?: string;
  groupOverrides?: Record<string, ViewGroupOverride>;
}

export interface WorkspacePresentation {
  kind?: "page";
  type?: "workspace";
  render?: string;
  title?: LocalizedText;
  subtitle?: LocalizedText;
  selectionParam?: string;
  defaultSelectionSource?: "firstRow" | "none";
  actions?: ViewAction[];
  layout?: {
    variant?: WorkspaceLayoutVariant;
  };
  slots?: {
    sidebar?: WorkspaceGroupSlot;
    list?: WorkspacePresentationSlot;
    body?: WorkspacePresentationSlot;
    related?: WorkspaceGroupSlot;
  };
}

export type PresentationDefinition =
  | ListPresentation
  | DetailPresentation
  | FormPresentation
  | SummaryPresentation
  | CardsPresentation
  | ListItemPresentation
  | WorkspacePresentation;

export type Presentations = Record<string, PresentationDefinition>;

export interface UIDefinition {
  routes?: Record<string, string | LocalizedText>;
  presentations?: Presentations;
}

export interface ViewSource {
  entity: string;
  profile?: string;
}

export interface ViewDefinition {
  schemaVersion: number;
  kind: "view";
  entity: string;
  sources: ViewSource[];
  routes: Record<string, string | LocalizedText>;
  actions?: Record<string, ViewActionDefinition>;
  groupSets?: Record<string, ViewGroup[]>;
  presentations: Record<string, ViewPresentationDefinition>;
}

export interface ViewPresentationDefinition {
  kind?: "page" | "embedded";
  type?: "list" | "detail" | "form" | "summary" | "cards" | "listItem" | "workspace";
  itemAction?: ItemAction;
  actions?: ViewAction[];
  rowActions?: ViewRowAction[];
  [context: string]: unknown;
}

// Keep old ViewContext for authoring passthrough
export interface ViewContext {
  presentations: Record<string, PresentationDefinition>;
  list?: ListPresentation;
  detail?: DetailPresentation;
  form?: FormPresentation;
  workspace?: WorkspacePresentation;
}
