// SPDX-License-Identifier: BUSL-1.1
import type { CompiledEntityContract, CompiledField } from "./types/compiled.js";
import type { FieldDefinition } from "./types/field-definition.js";

export type EntityValueReferenceDescriptor = {
  fieldKey: string;
  targetEntity: string;
  schema: string;
  table: string;
  /** Physical column on the carrier, never a key inside its values JSON. */
  column: string;
  /** Symbolic local argument name, never a stored entity identifier. */
  parameterColumn?: string;
  required: boolean;
  cardinality: "single";
};

export type EntityValueDefinitionDescriptor = {
  entityName: string;
  /** Content projection version, unrelated to entity authoring.schemaVersion. */
  schemaVersion: 1;
  definitionHash: string;
  /** Fully resolved normal entity fields, including profile fields. */
  fields: FieldDefinition[];
  valueSchema: Record<string, unknown>;
  references: EntityValueReferenceDescriptor[];
  materializeOperationId?: string;
};

export type EntityValueRegistry = {
  version: 1;
  carriers: Array<{
    entityName: string;
    fieldKey: string;
    definitionField: string;
    schema: string;
    table: string;
    valuesColumn: string;
    definitionColumn: string;
    definitions: Record<string, EntityValueDefinitionDescriptor>;
  }>;
  collections: Array<{
    entityName: string;
    fieldKey: string;
    targetEntity: string;
    allowedDefinitions: string[];
  }>;
};

/** Input comes from the normal entity compiler, not a second YAML catalog. */
export type EntityValueCandidate = {
  contract: CompiledEntityContract;
  effectiveFields: CompiledField[];
};
