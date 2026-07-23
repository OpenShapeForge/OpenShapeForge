// @ts-nocheck
/**
 * Relationship compiler — aggregates relationship declarations from core entity
 * and all profiles into a unified list.
 *
 * Pipeline position: called early by the main compiler, before GraphQL and view
 * compilation which both depend on the resolved relationship set. Validates that
 * no duplicate relationship keys exist across core and profile definitions.
 *
 * Input:  LoadedArtifacts (core entity relationships + profile relationships).
 * Output: CompiledRelationship[] — flat, deduplicated list of all entity relationships.
 */
import type { CompiledRelationship } from "../types.js";
import type { LoadedArtifacts } from "../loader.js";

export function resolveRelationships(artifacts: LoadedArtifacts): CompiledRelationship[] {
  const rels: CompiledRelationship[] = [];

  if (artifacts.coreEntity.relationships) {
    for (const rel of artifacts.coreEntity.relationships) {
      rels.push({
        key: rel.key,
        kind: rel.kind,
        target: rel.target,
        foreignKey: rel.foreignKey,
        via: rel.via,
        label: rel.label,
      });
    }
  }

  for (const profile of artifacts.profiles) {
    if (!profile.relationships) continue;
    for (const rel of profile.relationships) {
      rels.push({
        key: rel.key,
        kind: rel.kind,
        target: rel.target,
        foreignKey: rel.foreignKey,
        via: rel.via,
        label: rel.label,
      });
    }
  }

  // Detect duplicate keys
  const seen = new Set<string>();
  for (const rel of rels) {
    if (seen.has(rel.key)) {
      throw new Error(`Duplicate relationship key "${rel.key}" — defined in both core entity and profile`);
    }
    seen.add(rel.key);
  }

  return rels;
}
