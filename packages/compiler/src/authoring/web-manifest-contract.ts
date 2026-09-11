// SPDX-License-Identifier: BUSL-1.1
import type { LocalizedText } from "./types.js";

export type WebOperationIntent = "list" | "get" | "create" | "update" | "delete";
export type WebOperationRef = { id: string; intent: WebOperationIntent };
export type WebRendererKey =
  | "boolean"
  | "condition"
  | "date"
  | "datetime"
  | "labels"
  | "number"
  | "reference"
  | "status"
  | "text"
  | "textarea"
  | "variable-template";

export type WebVariableSource = {
  key: string;
  resolver: "chips" | "entityFields" | "templateParameters" | "workflowGraphVariables";
  params?: Record<string, unknown>;
};

export type WebFieldSuggestions = {
  sourceField?: string;
  sourceKey?: string;
};

export type WebFieldOption = {
  value: string;
  label: LocalizedText;
};

export type WebFieldProjection = {
  id: string;
  key: string;
  label: LocalizedText;
  description: LocalizedText;
  valueType: string;
  semanticType?: string;
  variables?: "none" | "whole" | "template" | "both";
  suggestions?: WebFieldSuggestions;
  options?: WebFieldOption[];
  cardinality: "one" | "many";
  required: boolean;
  /** Supported modes. Effective user authorization is resolved at runtime. */
  access: { read: boolean; create: boolean; update: boolean };
  renderers: {
    display: WebRendererKey;
    readonly: WebRendererKey;
    editable: WebRendererKey;
  };
  rendererProps?: Record<string, unknown>;
};

export type WebFieldGroup = { id: string; title: LocalizedText; fields: string[] };

export type WebCollectionView = {
  id: string;
  kind: "collection";
  operation: WebOperationRef;
  title: LocalizedText;
  searchPlaceholder: LocalizedText;
  displayField: string;
  columns: Array<{ fieldId: string; key: string; label: LocalizedText }>;
  defaultSort?: { key: string; direction: "asc" | "desc" };
};

export type WebRelationshipProjection = {
  id: string;
  key: string;
  label: LocalizedText;
  kind: string;
  targetEntityId: string;
  targetRoute: string;
  foreignKey: string;
  recordField: string;
  operations: { list?: WebOperationRef; get?: WebOperationRef; create?: WebOperationRef };
  collection?: WebCollectionView;
};

export type WebRecordTab = {
  id: string;
  label: LocalizedText;
  groups: WebFieldGroup[];
  relationshipId?: string;
};

export type WebRecordView = {
  id: string;
  kind: "record";
  preset: "inbox-main-context";
  load: WebOperationRef;
  titleTemplate: string;
  subtitleTemplate?: string;
  tabs: WebRecordTab[];
  context: { groups: WebFieldGroup[]; relationships: string[] };
  actions: { update?: WebOperationRef; delete?: WebOperationRef };
};

export type WebFormView = {
  id: string;
  kind: "form";
  intent: "create" | "update";
  operation: WebOperationRef;
  title: LocalizedText;
  groups: WebFieldGroup[];
  variableSources?: WebVariableSource[];
  submitLabel: LocalizedText;
};

export type WebEntityInterface = {
  entityId: string;
  entitySlug: string;
  route: string;
  title: LocalizedText;
  fields: Record<string, WebFieldProjection>;
  operations: Partial<Record<WebOperationIntent, WebOperationRef>>;
  collection: WebCollectionView;
  record?: WebRecordView;
  create?: WebFormView;
  update?: WebFormView;
  relationships: Record<string, WebRelationshipProjection>;
};

export type WebManifestV1 = {
  contract: "openshapeforge.web-manifest";
  version: 1;
  locale: "en" | "nl";
  entities: Record<string, WebEntityInterface>;
};

export type WebManifestOptions = {
  locale?: "en" | "nl";
  /** Context to prefer when an entity exposes multiple compiled view contexts. */
  context?: string;
  /** Route language may differ from the default content language. */
  routeLocale?: "en" | "nl";
};
