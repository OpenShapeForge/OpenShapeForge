// SPDX-License-Identifier: BUSL-1.1
/** Pure manifest registry; safe to use while canonical contracts are being initialized. */
import manifest from "../../generated/db/manifest.json" with { type: "json" };
import type { GeneratedCrudTable } from "./types.js";
export function isGeneratedCrudTableEligible(table: GeneratedCrudTable): boolean {
  return !table.domainInternal && table.generatedCrudEligible === true;
}

export const generatedCrudTables = new Map(
  (manifest.tables as GeneratedCrudTable[])
    .filter((table) => isGeneratedCrudTableEligible(table) && table.primaryKey)
    .map((table) => [table.name, table]),
);
export function getGeneratedCrudTables(): GeneratedCrudTable[] { return [...generatedCrudTables.values()]; }
