// SPDX-License-Identifier: BUSL-1.1
import type { JsonObject, JsonValue } from "./json.js";

export type ContentCardinality =
  | "single"
  | "collection"
  | { readonly min?: number; readonly max?: number | "unbounded" };

/** Resolved metadata, supplied by the compiler; semantic types are not re-registered here. */
export type ContentValueShape = {
  readonly osfType?: string;
  readonly baseType: "string" | "integer" | "number" | "boolean" | "date" | "datetime" | "object";
  readonly cardinality?: ContentCardinality;
  readonly required?: boolean;
  readonly nullable?: boolean;
  readonly enum?: readonly JsonValue[];
  readonly fields?: Readonly<Record<string, ContentValueShape>>;
};

export type ContentField = ContentValueShape & {
  readonly relationship?: { readonly target: string };
};

export type CompiledContentBlockDefinition = {
  readonly entityName: string;
  readonly schemaVersion: number;
  /** The compiler's fingerprint of the definition (fields, references, storage, Operations), frozen with every result. */
  readonly definitionHash?: string;
  readonly fields: Readonly<Record<string, ContentField>>;
  /** Output-channel to renderer identifier. No renderer code is executed by this engine. */
  readonly renderers: Readonly<Record<string, string>>;
  /** Exact compiler definition used for validation/presentation, frozen with the result. */
  readonly source?: JsonObject;
  /** Frozen canonical materialization output schema, not the input field shape. */
  readonly materializationSchema?: JsonObject;
  /** Optional compiled composition metadata, not a special hardcoded block entity. */
  readonly composition?: {
    readonly templateVersionField: string;
    readonly parametersField?: string;
  };
};

export type CompiledContentBlockRegistry = Readonly<Record<string, CompiledContentBlockDefinition>>;

/** References are supplied from relational storage, never discovered by scanning JSON values. */
export type ContentEntityReference = {
  readonly entity: string;
  readonly id: string;
  readonly versionId?: string;
};

export type ContentReferenceValue =
  | ContentEntityReference
  | { readonly parameter: string }
  | readonly ContentEntityReference[]
  | null;

export type ContentBlock = {
  readonly id: string;
  readonly definitionKey: string;
  readonly schemaVersion: number;
  readonly values: JsonObject;
  readonly references: Readonly<Record<string, ContentReferenceValue>>;
};

export type TemplateParameter = ContentValueShape & { readonly defaultValue?: JsonValue; readonly relationship?: { readonly target: string } };

export type ContentTemplateVariant = {
  readonly id: string;
  readonly channel: string;
  readonly locale: string;
  /** Served for its channel when no variant matches the requested language; at most one per channel. */
  readonly default?: boolean;
  /** The owning collection's order is authoritative. No second position property exists. */
  readonly blocks: readonly ContentBlock[];
  readonly allowedDefinitions?: readonly string[];
};

export type ContentTemplateVersion = {
  readonly id: string;
  readonly tenantId: string;
  readonly templateId: string;
  readonly versionNumber: number;
  readonly parameters: Readonly<Record<string, TemplateParameter>>;
  readonly variants: readonly ContentTemplateVariant[];
};

export type ContentResolvedVariable = {
  readonly tenantId: string;
  readonly sourceId: string;
  readonly sourceVersionId: string;
  readonly value: JsonValue;
};

export type ContentResolvedEntity = {
  readonly tenantId: string;
  readonly entity: string;
  readonly id: string;
  readonly versionId: string;
  readonly value: JsonObject;
};

type MaybePromise<T> = T | Promise<T>;

/** A canonical read Operation may materialize values or include an existing FK slot. */
export type ContentBlockMaterialization = {
  readonly operationId: string;
  readonly result:
    | { readonly kind: "block"; readonly value: JsonObject }
    | { readonly kind: "template"; readonly referenceField: string; readonly parameters: JsonObject };
};

/** The adapter must authorize reads with its verified session, then return tenant-scoped data. */
export type ContentResolvers = {
  readonly resolveTemplateVersion: (
    id: string,
    context: { readonly tenantId: string },
  ) => MaybePromise<ContentTemplateVersion | null>;
  readonly resolveGlobalVariable: (
    key: string,
    context: { readonly tenantId: string },
  ) => MaybePromise<ContentResolvedVariable | null>;
  readonly resolveEntity: (
    reference: ContentEntityReference,
    context: { readonly tenantId: string },
  ) => MaybePromise<ContentResolvedEntity | null>;
  /** Runtime adapters use the existing canonical FieldDefinition schema service here. */
  readonly validateParameters?: (
    version: ContentTemplateVersion,
    values: JsonObject,
  ) => MaybePromise<void>;
  readonly validateBlockValues?: (definitionKey: string, values: JsonObject) => MaybePromise<void>;
  readonly materializeBlock?: (input: {
    readonly definitionKey: string;
    readonly values: JsonObject;
    readonly references: MaterializedContentBlock["references"];
    readonly channel: string;
    readonly locale: string;
  }) => MaybePromise<ContentBlockMaterialization>;
};

export type MaterializeTemplateContentInput = {
  readonly tenantId: string;
  readonly templateVersionId: string;
  readonly channel: string;
  readonly locale: string;
  readonly parameters?: JsonObject;
};

export type MaterializedContentBlock = {
  readonly path: readonly string[];
  readonly id: string;
  readonly definitionKey: string;
  readonly schemaVersion: number;
  readonly renderer: string;
  readonly values: JsonObject;
  readonly references: Readonly<
    Record<string, ContentResolvedEntity | readonly ContentResolvedEntity[] | null>
  >;
  readonly materialization?: ContentBlockMaterialization;
};

export type MaterializedTemplateContent = {
  readonly schemaVersion: 1;
  readonly tenantId: string;
  readonly templateVersionId: string;
  readonly channel: string;
  readonly locale: string;
  readonly blocks: readonly MaterializedContentBlock[];
  readonly compositions: readonly {
    readonly path: readonly string[];
    readonly definitionKey: string;
    readonly schemaVersion: number;
    readonly values: JsonObject;
    readonly templateReference: ContentEntityReference;
    readonly references: MaterializedContentBlock["references"];
    readonly materialization?: ContentBlockMaterialization;
  }[];
  readonly templates: readonly {
    readonly path: readonly string[];
    readonly version: ContentTemplateVersion;
    readonly variantId: string;
    readonly parameters: JsonObject;
  }[];
  readonly definitions: CompiledContentBlockRegistry;
  readonly globals: Readonly<Record<string, ContentResolvedVariable>>;
  readonly compositionHashVersion: "osf-template-content-v1";
  readonly compositionHash: string;
};
