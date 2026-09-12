// SPDX-License-Identifier: BUSL-1.1
import type {
  OperationConcurrency,
  OperationConfirmation,
  OperationReference,
} from "@openshapeforge/operations";

export type LocalizedText = { en: string; nl: string };

export type WebOperationIntent = "list" | "get" | "create" | "update" | "delete";
export type WebOperationRef = OperationReference<WebOperationIntent>;
export type WebCustomOperationRef = OperationReference<"invoke"> & {
  /** Authored key inside the entity Operations map. */
  key: string;
  name: LocalizedText;
  description: LocalizedText;
  target: {
    entityId: string;
    entityName: string;
    scope: "collection" | "record";
    inputField?: string;
  };
  input: { kind: "json-schema"; schema: Readonly<Record<string, unknown>> };
  output: { kind: "json-schema"; schema: Readonly<Record<string, unknown>> };
  effects: {
    data: "read" | "write" | "delete";
    external: "none" | "read" | "write";
  };
  reliability: {
    idempotency: {
      mode: "natural" | "keyed" | "none";
      inputField?: string;
    };
  };
  concurrency?: OperationConcurrency;
  confirmation: OperationConfirmation;
  /** Authenticated browser execution endpoint, including honest binary output. */
  rest?: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    response: {
      status?: number;
      kind: "json" | "binary" | "stream";
      contentType?: string;
    };
  };
};
export type WebViewMode = "read" | "create" | "update";

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

export type WebFieldOptionSource =
  | { type: "referentiedata"; group: string }
  | { type: "remote" | "dynamic"; source: string };

/**
 * Semantic field projection. A renderer registry resolves presentation from
 * semanticType, valueType, cardinality, surface and mode; fields never name a
 * component or renderer as their default behaviour.
 */
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
  optionSource?: WebFieldOptionSource;
  cardinality: "one" | "many";
  required: boolean;
  /** Static capabilities only. Effective rights arrive in operation offers. */
  supports: { read: boolean; create: boolean; update: boolean };
};

export type WebFieldGroup = { id: string; title: LocalizedText; fields: string[] };

export type WebCollectionView = {
  id: string;
  kind: "collection";
  renderer: "entity.collection";
  modes: readonly ["read"];
  route: string;
  operations: {
    read: WebOperationRef;
    create?: WebOperationRef;
    /** Ordered server-authored collection actions shown by the browser. */
    actions?: WebCustomOperationRef[];
  };
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
  renderer: "entity.record";
  preset: "inbox-main-context";
  modes: WebViewMode[];
  routes: {
    read?: string;
    create?: string;
  };
  operations: {
    read?: WebOperationRef;
    create?: WebOperationRef;
    update?: WebOperationRef;
    delete?: WebOperationRef;
    /** Ordered server-authored record actions shown by the browser. */
    actions?: WebCustomOperationRef[];
  };
  titleTemplate: string;
  subtitleTemplate?: string;
  layout: {
    tabs: WebRecordTab[];
    context: { groups: WebFieldGroup[]; relationships: string[] };
  };
  variableSources?: WebVariableSource[];
  labels: {
    createTitle?: LocalizedText;
    updateTitle?: LocalizedText;
    createSubmit?: LocalizedText;
    updateSubmit?: LocalizedText;
  };
};

export type WebEntityView = WebCollectionView | WebRecordView;

export type WebEntityInterface = {
  entityId: string;
  entitySlug: string;
  title: LocalizedText;
  fields: Record<string, WebFieldProjection>;
  operations: Record<string, WebOperationRef | WebCustomOperationRef>;
  views: {
    collection: WebCollectionView;
    record?: WebRecordView;
  };
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
