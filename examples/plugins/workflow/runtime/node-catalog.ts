// SPDX-License-Identifier: BUSL-1.1
/**
 * What a workflow node type looks like to everything that is not the store.
 *
 * The store speaks the table's language — snake_case columns, jsonb blobs, a
 * catalog checksum, an `outputFields` array only the runtime cares about. This
 * layer exists so that a designer, a validator or a resolver never has to. It
 * hands back one flat record per node type and nothing else.
 *
 * `label` and `description` stay `Record<string, string>` rather than being
 * resolved to a single string. Which locale a caller wants depends on the
 * request, not on the catalog, and a layer that picked one here would have
 * every other caller re-deriving what it discarded.
 *
 * Lookups inherit the store's precondition: hydrate before you read, or the
 * read throws.
 */
import { getCatalogEntry, getCatalogList, type CatalogEntry } from "./node-catalog-store.js";

export type WorkflowNodeType = {
  type: string;
  category: string;
  label: Record<string, string>;
  description: Record<string, string> | null;
  configFields: unknown[];
};

function mapWorkflowNodeType(entry: CatalogEntry): WorkflowNodeType {
  return {
    type: entry.nodeType,
    category: entry.category,
    label: entry.label,
    description: entry.description ?? null,
    configFields: entry.configFields,
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
