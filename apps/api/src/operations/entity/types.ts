// SPDX-License-Identifier: BUSL-1.1
import type {
  OperationConcurrency,
  OperationEnvelope,
  OperationError,
  OperationOffer,
  OperationPrerequisite,
  OperationConfirmation,
  OperationReference,
  OperationResult,
} from "@openshapeforge/operations";

export type GeneratedCrudOperation = "read" | "create" | "update" | "delete";
export type GeneratedCrudExposureOperation = "list" | "get" | "create" | "update" | "delete";

export type GeneratedCrudAuthorization = {
  roles: Record<GeneratedCrudOperation, string[]>;
  recordPermissions?: {
    field: string;
    column: string;
    empty: "public" | "restricted";
    createRequires: Array<"view" | "edit" | "delete">;
    defaultValue?: Record<string, unknown>;
  };
};

export type GeneratedCrudColumn = {
  name: string;
  type: string;
  required: boolean;
  primaryKey: boolean;
  generated: string | null;
  sourceField?: string;
  classification?: "confidential" | "pii" | "bsn";
  immutable?: boolean;
  writtenBy?: {
    operation: string;
    rest: string;
    mcp?: string;
  }[];
};

export type GeneratedCrudRelationship = {
  name: string;
  target: string;
  type: string;
  resolve: "belongsTo" | "hasMany";
  foreignKey?: string;
  fieldKey?: string;
  kind?: "belongsTo" | "hasMany" | "manyToMany";
  inverse?: string;
  ownership?: "owned" | "reference";
  cardinality?: "single" | "collection" | { min?: number; max?: number | "unbounded" };
  sortable?: boolean;
  positionColumn?: string;
  via?: string;
  viaSchema?: string;
  mutationSupport?: "unsupported";
  constraints?: Record<
    string,
    { eq: string | number | boolean } | {
      any: Record<string, { eq: string | number | boolean }>;
    }
  >;
};

export type GeneratedCrudTable = {
  name: string;
  schema: string;
  table: string;
  tenantScoped: boolean;
  domainInternal: boolean;
  generatedCrudEligible?: boolean;
  generatedCrud: boolean;
  primaryKey: string | null;
  columns: GeneratedCrudColumn[];
  realtime?: { readPredicate: string; visibilityColumns: string[] };
  source?: {
    blueprint?: { fields: string[]; labelField: string; operations: { list: string; status: string; reset: string; publish: string } };
    authoringEntityName?: string;
    /** Present only for strict v2 entity authoring; absence means legacy v1. */
    authoringVersion?: 2 | 3;
    computedFields?: Array<{
      field: string;
      resolver: "labelRules";
    }>;
    crud?: {
      operations: Record<GeneratedCrudExposureOperation, boolean>;
    };
    secureInputOnCreate?: {
      sourceField: string;
      sourceEntity: string;
      definitionsField: string;
      into: string;
      message?: string;
    };
    graphql?: {
      typeName: string;
      singleQueryName: string;
      listQueryName: string;
      createMutationName: string;
      updateMutationName: string;
      deleteMutationName: string;
      operations?: Record<GeneratedCrudExposureOperation, boolean>;
      relationships?: GeneratedCrudRelationship[];
      defaultSort?: { field: string; direction: "asc" | "desc" };
    };
    rest?: {
      basePath: string;
      operations: Record<GeneratedCrudExposureOperation, boolean>;
    };
    mcp?: {
      toolPrefix: string;
      tools: "dedicated" | "generic";
      operations: Record<GeneratedCrudExposureOperation, boolean>;
      elicitOnCreate?: {
        sourceField: string;
        sourceEntity: string;
        definitionsField: string;
        into: string;
        message?: string;
      };
    };
    authorization?: GeneratedCrudAuthorization;
  };
};

export type GeneratedEntityRow = Record<string, unknown>;

export type GeneratedEntityConnection = {
  rows: GeneratedEntityRow[];
  nextCursor: string | null;
  totalCount: number | null;
};

export type ListPageInput = {
  limit?: number | null;
  cursor?: string | null;
  filter?: Record<string, unknown> | null;
  sort?: { field?: string | null; direction?: string | null } | null;
  includeTotalCount?: boolean;
};

export type CountedEntityConnection = GeneratedEntityConnection & {
  totalCount: number;
};

export type EntityOperationRef = OperationReference<GeneratedCrudExposureOperation>;

export type EntityOperationContract = EntityOperationRef & {
  key: string;
  entityId: string;
  entityName: string;
  name: string | Readonly<Record<string, string>>;
  description: string | Readonly<Record<string, string>>;
  implementation?: { type: "entity" } | { type: "plugin"; plugin: string; handler: string };
  target?:
    | { entityId: string; entityName: string; scope: "collection" }
    | { entityId: string; entityName: string; scope: "record"; inputField: string };
  errors?: import("../runtime.js").OperationContract["errors"];
  interfaces?: {
    rest?: false | {
      method?: string;
      path?: string;
      response?: { status?: number; kind?: "json" | "binary" | "stream"; contentType?: string };
    };
    graphql?: false | { field?: string; kind?: "query" | "mutation" };
    mcp?: false | { name?: string };
    web?: false | Record<string, unknown>;
  };
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  /** Concrete compiler projections, including platform mutation controls. */
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  authorization: {
    action: GeneratedCrudOperation;
    roles: string[];
    recordPermissions?: Array<"view" | "edit" | "delete">;
  };
  concurrency?: OperationConcurrency;
  effects: {
    data: "read" | "write" | "delete";
    external: "none" | "read" | "write";
  };
  reliability: {
    idempotency: { mode: "natural" | "keyed" | "none"; inputField?: string };
  };
  prerequisites?: readonly OperationPrerequisite[];
  interaction: {
    confirmation: OperationConfirmation;
    secureInput?: {
      type: "secureInput";
      sourceField: string;
      sourceEntity: string;
      definitionsField: string;
      into: string;
      message?: string;
    };
  };
};

export type EntityOperationInput = ListPageInput & {
  /** Plugin-backed CRUD takes its canonical authored input, not forced values. */
  [key: string]: unknown;
  id?: string;
  blueprintId?: string;
  values?: Record<string, unknown>;
  expectedVersion?: string;
  leaseToken?: string;
  confirmed?: boolean;
  confirmationToken?: string;
  confirmationAnswer?: string;
};

export type EntityOperationRequest = {
  operation: EntityOperationRef;
  input?: EntityOperationInput;
  /** Interface projection to intersect with authorized result offers. */
  offerIntents?: readonly GeneratedCrudExposureOperation[];
};

export type EntityOperationOffer = OperationOffer<GeneratedCrudExposureOperation | "invoke">;
export type EntityOperationError = OperationError;
export type EntityRecordEnvelope = OperationEnvelope<
  GeneratedEntityRow | null,
  GeneratedCrudExposureOperation | "invoke"
>;
export type EntityCollectionData = {
  items: OperationEnvelope<GeneratedEntityRow, GeneratedCrudExposureOperation | "invoke">[];
  nextCursor: string | null;
  totalCount: number | null;
};

export type EntityOperationResult =
  | ({ intent: "list" } & OperationResult<
      EntityCollectionData,
      GeneratedCrudExposureOperation | "invoke"
    >)
  | ({ intent: "get" | "create" | "update" } & OperationResult<
      GeneratedEntityRow | null,
      GeneratedCrudExposureOperation | "invoke"
    >)
  | ({ intent: "delete" } & OperationResult<
      { deleted: boolean },
      GeneratedCrudExposureOperation | "invoke"
    >);
