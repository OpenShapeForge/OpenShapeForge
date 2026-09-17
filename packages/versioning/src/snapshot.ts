// SPDX-License-Identifier: BUSL-1.1
/**
 * Pure helpers over the snapshot tree `publish()` stores on a version row:
 * `{ schemaVersion: 1, entity, head: { table, row, children: { <table>: [...] } } }`.
 * No database, no session; callers pass the parsed JSON.
 */

export type SnapshotRow = Readonly<Record<string, unknown>>;
export type SnapshotNode = {
  readonly table: string;
  readonly row: SnapshotRow;
  readonly children: Readonly<Record<string, readonly SnapshotNode[]>>;
};
export type PublishedSnapshot = {
  readonly schemaVersion: 1;
  readonly entity: string;
  readonly head: SnapshotNode;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

function parseNode(value: unknown, path: string): SnapshotNode {
  if (!isRecord(value) || typeof value.table !== "string" || !isRecord(value.row) || !isRecord(value.children)) {
    throw new Error(`Snapshot node ${path} is malformed.`);
  }
  const children: Record<string, SnapshotNode[]> = {};
  for (const [table, entries] of Object.entries(value.children)) {
    if (!Array.isArray(entries)) throw new Error(`Snapshot children ${path}.${table} must be an array.`);
    children[table] = entries.map((entry, index) => parseNode(entry, `${path}.${table}[${index}]`));
  }
  return { table: value.table, row: value.row, children };
}

/** Validates the stored shape; a malformed snapshot is a bug, never user input. */
export function parseSnapshot(value: unknown): PublishedSnapshot {
  const snapshot = typeof value === "string" ? JSON.parse(value) : value;
  if (!isRecord(snapshot) || snapshot.schemaVersion !== 1 || typeof snapshot.entity !== "string") {
    throw new Error("Snapshot must be a schemaVersion 1 published snapshot.");
  }
  return { schemaVersion: 1, entity: snapshot.entity, head: parseNode(snapshot.head, "head") };
}

/** Direct children stored under one table name, in stored order. */
export function childNodes(node: SnapshotNode, table: string): readonly SnapshotNode[] {
  return Object.hasOwn(node.children, table) ? node.children[table]! : [];
}

/**
 * Children of one table ordered the way the owning collection orders them:
 * by the `<fk>_position` column when present, then by id. `publish()` already
 * stores them in that order; sorting again keeps callers independent of it.
 */
export function orderedChildren(node: SnapshotNode, table: string, positionColumn?: string): readonly SnapshotNode[] {
  const entries = childNodes(node, table);
  const column = positionColumn ?? Object.keys(entries[0]?.row ?? {}).find((key) => key.endsWith("_position"));
  return [...entries].sort((left, right) => {
    const delta = column ? Number(left.row[column] ?? 0) - Number(right.row[column] ?? 0) : 0;
    return delta || String(left.row.id ?? "").localeCompare(String(right.row.id ?? ""));
  });
}

/** The first child of `table` whose row matches every given column value. */
export function findChild(node: SnapshotNode, table: string, match: SnapshotRow): SnapshotNode | undefined {
  return childNodes(node, table).find((child) => Object.entries(match).every(([column, value]) => child.row[column] === value));
}

/** Row id as a string; snapshot rows always carry the primary key. */
export function rowId(node: SnapshotNode): string {
  const id = node.row.id;
  if (typeof id !== "string" || !id) throw new Error(`Snapshot row in ${node.table} has no id.`);
  return id;
}
