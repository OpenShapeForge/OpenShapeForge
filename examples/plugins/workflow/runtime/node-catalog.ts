// SPDX-License-Identifier: BUSL-1.1
/**
 * What a workflow node type looks like to everything that is not the store.
 *
 * The store speaks the table's language — snake_case columns, jsonb blobs, a
 * catalog checksum. This layer exists so that a designer, a validator or a
 * resolver never has to. It hands back one flat record per node type and
 * nothing else.
 *
 * `label` and `description` stay `Record<string, string>` rather than being
 * resolved to a single string. Which locale a caller wants depends on the
 * request, not on the catalog, and a layer that picked one here would have
 * every other caller re-deriving what it discarded.
 *
 * Two fields describe a node type's standing rather than its shape, and they
 * answer different questions. `catalog` is provenance — which pack authored it.
 * `runtimeSupport` is capability — whether this deployment will run it. A
 * palette gates on the second and groups by the first; node-executability.ts
 * sets out why neither substitutes for the other.
 *
 * Lookups inherit the store's precondition: hydrate before you read, or the
 * read throws.
 */
import { getCatalogEntry, getCatalogList, type CatalogEntry } from "./node-catalog-store.js";
import {
  getWorkflowNodeRuntimeSupport,
  type WorkflowNodeRuntimeSupport,
} from "./node-executability.js";

export type WorkflowNodeType = {
  type: string;
  catalog: string;
  category: string;
  label: Record<string, string>;
  description: Record<string, string> | null;
  configFields: unknown[];
  /**
   * Defaults to `[]`, never null: the column is `NOT NULL DEFAULT '[]'` and the
   * GraphQL field is non-null, so a row that somehow carries SQL NULL must not
   * take the whole query down with it.
   */
  outputFields: unknown[];
  runtimeSupport: WorkflowNodeRuntimeSupport;
};

function mapWorkflowNodeType(entry: CatalogEntry): WorkflowNodeType {
  return {
    type: entry.nodeType,
    catalog: entry.catalog,
    category: entry.category,
    label: entry.label,
    description: entry.description ?? null,
    configFields: entry.configFields,
    outputFields: entry.outputFields ?? [],
    runtimeSupport: getWorkflowNodeRuntimeSupport(entry.nodeType),
  };
}

export function listWorkflowNodeTypes(): WorkflowNodeType[] {
  return getCatalogList().map(mapWorkflowNodeType);
}

export function getWorkflowNodeType(type: string): WorkflowNodeType | null {
  const normalized = type.trim();
  if (!normalized) {
    return null;
  }
  const entry = getCatalogEntry(normalized);
  return entry ? mapWorkflowNodeType(entry) : null;
}
