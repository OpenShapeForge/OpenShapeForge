// SPDX-License-Identifier: BUSL-1.1
import type { ExtensionIndexColumn, OsfTypeIndexProjection } from "./types/authoring.js";

/**
 * Top-level `extensionRegistry` of the backend manifest: every entity that
 * accepts tenant-defined fields, the storage the compiler gave it, and the
 * reverse map a "referenced by" read walks. The runtime keeps its own copy of
 * this type with a hand-written validator, as it does for `entityValues`.
 */
export type ExtensionRegistry = {
  entities: Record<string, ExtensionRegistryEntity>;
  /** Index projection of every object type an extensible entity allows. */
  indexProjections: Record<string, OsfTypeIndexProjection>;
  /** Target entity -> the extensible entities whose tenant reference fields may point at it. */
  referencedBy: Record<string, Array<{ sourceEntity: string; valuesTable: string }>>;
};

export type ExtensionRegistryEntity = {
  /** `schema.table` of the entity, which carries the `extension_values` source column. */
  table: string;
  /** `schema.table` of the typed index rows. */
  valuesTable: string;
  /** `schema.table` of the claimed values of `unique` text fields. */
  uniqueTable: string;
  manageRoles: string[];
  limits: { fields: number; filtersPerQuery: number; formulaDepth: number; syncFanOut: number };
  allowedOsfTypes: string[];
  targets: Array<{ entity: string; table: string }>;
  /** Owned children of which a record has at most one; a formula may read their fields. */
  ownedSingleChildren: Array<{ relation: string; entity: string; table: string; foreignKey: string }>;
};

export type { ExtensionIndexColumn };
