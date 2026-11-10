// SPDX-License-Identifier: BUSL-1.1
import type { CompiledEntityContract } from './types/compiled.js';

/** Canonical list queries share the grouping keys of all routed collection views. */
export function collectionGroupingFields(contract: CompiledEntityContract): { collectionGroupBy?: string; collectionSummaryBy?: string } {
  const web = contract.interfaces?.web;
  const tables = [web?.collectionTable, ...Object.values(web?.namedViews ?? {}).flatMap(view => view.kind === 'collection' && 'table' in view ? [view.table] : [])];
  const groups = new Set(tables.map(table => table?.groupBy).filter((key): key is string => Boolean(key)));
  const summaries = new Set(tables.map(table => table?.summary?.field).filter((key): key is string => Boolean(key)));
  if (groups.size > 1) throw new Error(`${contract.entity.name}: routed collections currently require the same grouping field.`);
  if (summaries.size > 1) throw new Error(`${contract.entity.name}: routed collections currently require the same summary field.`);
  const group = [...groups][0], summary = [...summaries][0];
  return { ...(group ? { collectionGroupBy: group } : {}), ...(summary ? { collectionSummaryBy: summary } : {}) };
}
