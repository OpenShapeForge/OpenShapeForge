// @ts-nocheck
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FieldOptions } from "../types.js";

export type ReferentieItem = {
  value: string;
  label: { nl: string; en: string };
};

export type CoreReferentiedataByGroep = Record<string, ReferentieItem[]>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_SNAPSHOT_PATH = join(
  __dirname,
  "../../../config/referentiedata/core-by-groep.json",
);

const coreData: CoreReferentiedataByGroep = JSON.parse(
  readFileSync(CORE_SNAPSHOT_PATH, "utf8"),
) as CoreReferentiedataByGroep;

function dedupeReferentieItems(items: ReferentieItem[]): ReferentieItem[] {
  const seen = new Set<string>();
  const deduped: ReferentieItem[] = [];

  for (const item of items) {
    if (seen.has(item.value)) {
      continue;
    }
    seen.add(item.value);
    deduped.push(item);
  }

  return deduped;
}

export function getCoreReferentieItemsForGroep(groep: string): ReferentieItem[] {
  return dedupeReferentieItems(coreData[groep] ?? []);
}

export function getReferentieItemsForGroep(groep: string): ReferentieItem[] {
  return getCoreReferentieItemsForGroep(groep);
}

/**
 * Turns compiled FieldOptions into the shape emitted by the app generator for
 * static selects (items only). Referentiedata is expanded using the core
 * catalog snapshot (`config/referentiedata/core-by-groep.json`).
 */
export function resolveFieldOptionsForClient(
  options: FieldOptions | Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!options) return undefined;

  const o = options as Record<string, unknown>;
  const type = o.type as string | undefined;

  if (type === "referentiedata") {
    const groep = o.referentieGroep as string | undefined;
    if (!groep) {
      return { type: "static", items: [] };
    }
    const items = getReferentieItemsForGroep(groep);
    if (items.length === 0) {
      console.warn(
        `[schema-compiler] referentiedata: no rows for groep "${groep}" in the core snapshot (regenerate referentiedata artifacts or check referentieGroep spelling)`,
      );
    }
    return { type: "static", items };
  }

  if (type === "static" && Array.isArray(o.items)) {
    return { type: "static", items: o.items };
  }

  if (!type && Array.isArray(o.items)) {
    return { type: "static", items: o.items };
  }

  return o as Record<string, unknown>;
}
