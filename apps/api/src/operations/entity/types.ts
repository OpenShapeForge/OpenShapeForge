// SPDX-License-Identifier: BUSL-1.1

export type GeneratedCrudOperation = "read" | "create" | "update" | "delete";
export type GeneratedCrudExposureOperation = "list" | "get" | "create" | "update" | "delete";

export type GeneratedCrudAuthorization = {
  roles: Record<GeneratedCrudOperation, string[]>;
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
  source?: {
    authoringEntityName?: string;
    crud?: {
      operations: Record<GeneratedCrudExposureOperation, boolean>;
    };
    graphql?: {
      typeName: string;
      singleQueryName: string;
      listQueryName: string;
      createMutationName: string;
      updateMutationName: string;
      deleteMutationName: string;
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

export type EntityOperationRef = {
  id: string;
  intent: GeneratedCrudExposureOperation;
};

export type EntityOperationContract = EntityOperationRef & {
  entityId: string;
  entityName: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  authorization: {
    action: GeneratedCrudOperation;
    roles: string[];
  };
  interaction: { confirmation: "none" };
};

export type EntityOperationInput = ListPageInput & {
  id?: string;
  values?: Record<string, unknown>;
};

export type EntityOperationRequest = {
  operation: EntityOperationRef;
  input?: EntityOperationInput;
};

export type EntityOperationResult =
  | { intent: "list"; connection: GeneratedEntityConnection }
  | { intent: "get" | "create" | "update"; record: GeneratedEntityRow | null }
  | { intent: "delete"; deleted: boolean };
