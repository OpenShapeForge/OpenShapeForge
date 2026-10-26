// SPDX-License-Identifier: BUSL-1.1
/**
 * The storage column that orders the children of a sortable owned collection.
 * The backend manifest creates it on the child table beside the owning foreign
 * key; the web and backend relationship metadata name it; list contracts offer
 * it as a sort key. One spelling, so the three never disagree.
 */
export function sortablePositionColumn(foreignKey: string): string {
  return `${foreignKey}_position`;
}

type RelationshipOwner = {
  readonly entity: { readonly name: string };
  readonly model: {
    readonly relationships: ReadonlyArray<{
      readonly kind: string;
      readonly target: string;
      readonly sortable?: boolean;
      readonly foreignKey?: string;
      readonly via?: string;
      readonly through?: unknown;
    }>;
  };
};

/**
 * The record keys of `entity`'s collection positions: one per sortable owned
 * collection of another entity whose children are `entity`, spelled as the
 * runtime serializes the column (`document_variant_id_position` →
 * `documentVariantIdPosition`). Sorting a list on one of these returns a
 * collection's children in their authored order.
 */
export function sortablePositionFieldKeys(
  entity: string,
  contracts: readonly RelationshipOwner[],
): string[] {
  const keys = new Set<string>();
  for (const owner of contracts) {
    for (const relationship of owner.model.relationships) {
      if (relationship.kind !== "hasMany" || relationship.target !== entity || !relationship.sortable) continue;
      if (!relationship.foreignKey || relationship.via || relationship.through) continue;
      keys.add(sortablePositionColumn(relationship.foreignKey).replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase()));
    }
  }
  return [...keys].sort();
}
