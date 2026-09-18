// SPDX-License-Identifier: BUSL-1.1
/**
 * Which relationships of an entity a web view actually shows.
 *
 * Every single reference derives a collection on its target, so an entity
 * can carry many collections that no screen displays. They exist in the
 * model, GraphQL, MCP and the manifest, but a generated page query selects
 * a collection's aggregate only when a view surfaces it: a record tab or
 * group bound to it, a `context.relationships` entry, a timeline include,
 * or an embedded list. Everything else costs nothing at query time.
 */
import type { CompiledEntityContract } from "../types.js";

function collect(node: unknown, keys: Set<string>): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collect(item, keys);
    return;
  }
  const record = node as Record<string, unknown>;
  const relationship = record.relationship;
  if (typeof relationship === "string") keys.add(relationship);
  else if (relationship && typeof relationship === "object" && typeof (relationship as { name?: unknown }).name === "string") {
    keys.add((relationship as { name: string }).name);
  }
  if (typeof record.relationshipId === "string") keys.add(record.relationshipId);
  const relationships = record.relationships;
  if (Array.isArray(relationships)) {
    for (const usage of relationships) {
      if (typeof usage === "string") keys.add(usage);
      else if (usage && typeof usage === "object" && typeof (usage as { name?: unknown }).name === "string") keys.add((usage as { name: string }).name);
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "relationship" || key === "relationships" || key === "relationshipId") continue;
    collect(value, keys);
  }
}

/** Relationship keys referenced anywhere in the entity's compiled views or web record context. */
export function surfacedRelationshipKeys(contract: Pick<CompiledEntityContract, "views" | "interfaces">): Set<string> {
  const keys = new Set<string>();
  collect(contract.views, keys);
  collect(contract.interfaces?.web?.recordContext, keys);
  return keys;
}
