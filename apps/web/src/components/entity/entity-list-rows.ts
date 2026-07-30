// SPDX-License-Identifier: BUSL-1.1
import type { EntityListColumn } from "@/components/ui/data-table/columns/map-schema-columns";

export const ENTITY_LIST_PAGE_SIZE = 25;

export type EntityListConnection = {
  edges?: Array<{ node?: Record<string, unknown> | null; cursor?: string }>;
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  totalCount?: number;
};

/**
 * Row source column shape used by `mapConnectionRows`. Aliased to
 * `EntityListColumn` (which now owns the optional `accessor` field).
 */
export type EntityListRowSourceColumn = EntityListColumn;

export function getValue(node: Record<string, unknown> | null | undefined, accessor: string): unknown {
  return accessor.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }

    return (current as Record<string, unknown>)[key];
  }, node) ?? "-";
}

export function mapConnectionRows(
  connection: EntityListConnection | null | undefined,
  columns: EntityListRowSourceColumn[],
): Record<string, unknown>[] {
  return (connection?.edges ?? []).map(({ node }) => {
    const nodeId = node && typeof node === "object"
      ? (node as Record<string, unknown>).id
      : undefined;
    const row: Record<string, unknown> =
      typeof node === "object" && node !== null
        ? { ...node, id: nodeId }
        : { id: nodeId };

    for (const column of columns) {
      row[column.key] = getValue(node, column.accessor ?? column.key);
    }

    return row;
  });
}
