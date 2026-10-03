// SPDX-License-Identifier: BUSL-1.1
/**
 * Relationship compiler — projects the relational fields of the normalized
 * core entity into the flat CompiledRelationship list that GraphQL, storage,
 * views and the interface manifests consume.
 *
 * Every relationship is a field: a single entity reference (`belongsTo`) or
 * a collection the compiler derived from one (`hasMany`, see
 * ../inverse-collections.ts). Profiles contribute no relationships of their
 * own.
 */
import type { CompiledRelationship } from "../types.js";
import type { LoadedArtifacts } from "../loader.js";

export function resolveRelationships(artifacts: LoadedArtifacts): CompiledRelationship[] {
  const rels: CompiledRelationship[] = [];

  for (const field of artifacts.coreEntity.fields) {
    const rel = field.relationship;
    if (!rel?.target) continue;
    if (rel.kind !== "belongsTo" && rel.kind !== "hasMany") {
      throw new Error(`${artifacts.coreEntity.entity}.${field.key}: relationship is not normalized.`);
    }
    rels.push({
      key: field.key,
      fieldKey: field.key,
      kind: rel.kind,
      target: rel.target,
      ...(rel.foreignKey ? { foreignKey: rel.foreignKey } : {}),
      ...(typeof rel.inverse === "string" ? { inverse: rel.inverse } : {}),
      ...(rel.through ? { through: rel.through } : {}),
      ...(rel.ownership ? { ownership: rel.ownership } : {}),
      ...(field.cardinality ? { cardinality: field.cardinality } : {}),
      ...(field.sortable ? { sortable: field.sortable } : {}),
      ...(field.childAuthorization ? { childAuthorization: field.childAuthorization } : {}),
      ...(field.childLock ? { childLock: field.childLock } : {}),
      ...(rel.version ? { version: rel.version } : {}),
      ...(rel.unique ? { unique: rel.unique } : {}),
      ...(field.label ? { label: field.label } : {}),
      ...(rel.constraints ? { constraints: structuredClone(rel.constraints) } : {}),
      ...(rel.provider ? { provider: structuredClone(rel.provider) } : {}),
    });
  }

  const seen = new Set<string>();
  for (const rel of rels) {
    if (seen.has(rel.key)) throw new Error(`Duplicate relationship key "${rel.key}" on ${artifacts.coreEntity.entity}`);
    seen.add(rel.key);
  }

  return rels;
}
