// SPDX-License-Identifier: BUSL-1.1
import type { CompiledEntityContract, CompiledField } from "./types/compiled.js";

type Candidate = { contract: CompiledEntityContract; effectiveFields: readonly CompiledField[] };

/** Resolve the same version binding for storage and every interface projection. */
export function resolveValueFieldsFrom(candidate: Candidate, candidates: readonly Candidate[]): void {
  for (const field of candidate.effectiveFields) {
    const binding = field.valueFieldsFrom;
    if (!binding) continue;
    const name = candidate.contract.entity.name;
    if (!candidate.contract.entity.valueDefinition) throw new Error(`${name}.${field.key}: valueFieldsFrom is currently supported only on entity-value definitions.`);
    const reference = candidate.effectiveFields.find(item => item.key === binding.reference);
    const heads = candidates.filter(item => item.contract.versioning?.versionEntity === reference?.relationship?.target);
    const versions = candidates.filter(item => item.contract.entity.name === reference?.relationship?.target);
    const source = heads.length === 1 ? heads[0]!.effectiveFields.find(item => item.key === binding.field) : undefined;
    const column = heads.length === 1 ? heads[0]!.contract.storage.columns.find(item => item.field === binding.field) : undefined;
    const snapshot = versions.length === 1 ? versions[0]!.contract.storage.columns.find(item => item.field === "snapshot") : undefined;
    if (field.baseType !== "object" || field.cardinality !== "single" || !reference?.relationship?.target || reference.cardinality !== "single" ||
      heads.length !== 1 || source?.osfType !== "fieldDefinition" || source.cardinality !== "collection" || !column || column.type !== "jsonb" || snapshot?.type !== "jsonb") {
      throw new Error(`${name}.${field.key}: valueFieldsFrom requires a version reference and stored FieldDefinition collection.`);
    }
    field.valueFieldsFrom = { ...binding, snapshotColumn: column.column, headEntity: heads[0]!.contract.entity.name };
  }
}
