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
  /**
   * The single relations of a collection's child that is not extensible
   * itself, by child entity: what `rollup.of` may follow from the child. An
   * extensible child has them in its own `relations`.
   */
  childRelations: Record<string, ExtensionRegistryRelation[]>;
  /**
   * Who may read each entity a tenant lookup or rollup can reach — every
   * extensible entity, every reference target, every entity across an
   * authored relation of an extensible one and every entity a child's single
   * relation leads to — from its compiled authorization contract. The runtime proves from this that a lookup or rollup shows no
   * reader of the source anything the target would hide from them; an entity
   * missing here is never a lookup or rollup target. An entity no interface
   * reads is not a target or relation at all, so it is missing here unless it
   * is extensible itself.
   */
  readAccess: Record<string, ExtensionReadAccess>;
};

export type ExtensionReadAccess = {
  /** `schema.table` of the entity. */
  table: string;
  /** The roles that may read it (its `read` roles). */
  roles: string[];
  /** The principal classes its reads admit; absent means every class. */
  principalClasses?: string[];
  /**
   * Set when its rows are visible to fewer than all its readers: the axis
   * that narrows them (`rowScope`, `ownerAxis`, `recordPermissions`, `rowAccess`
   * for an owner or group axis, `profileAuthorizations`). Absent means every
   * reader sees every row of the tenant.
   */
  rowPolicy?: string;
  /** Fields with read roles of their own (`fieldAuthorizations`), by field key. */
  fieldReadRoles?: Record<string, string[]>;
  /**
   * The fields authored `sensitivity: internal`, by field key. `internal`
   * restricts no reader, so no column carries it, but a computed field that
   * reads one is `internal` at least.
   */
  internalFields?: string[];
};

/** An authored single relation or inverse collection of an extensible entity. */
export type ExtensionRegistryRelation = {
  /** The relation's field key: the reference on the entity, or the inverse collection. */
  key: string;
  /** `belongsTo`: the entity holds `foreignKey`; `hasMany`: the related entity holds it. */
  kind: "belongsTo" | "hasMany";
  entity: string;
  /** `schema.table` of the related entity. */
  table: string;
  foreignKey: string;
  ownership?: "owned" | "reference";
  /** The collection's children are authorized through this entity. */
  childAuthorization?: "owner";
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
  /** Authored relations a tenant lookup may follow (`belongsTo`) or a rollup aggregate (`hasMany`). */
  relations: ExtensionRegistryRelation[];
};

export type { ExtensionIndexColumn };
