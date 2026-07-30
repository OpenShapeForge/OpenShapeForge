// SPDX-License-Identifier: BUSL-1.1
import bySoort from "./vera-referentiedata-by-soort.json";

export type ReferentieItem = {
  value: string;
  label: { nl: string; en: string };
};

type BySoort = Record<string, ReferentieItem[]>;

const data = bySoort as BySoort;

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

/**
 * VERA referentiedata snapshot (Soort → codes/labels). Canonical copy is
 * `packages/compiler/config/referentiedata/vera-by-soort.json`; this file is a
 * web-runtime copy consumed by renderer option resolution.
 */
export function getReferentieItemsForSoort(soort: string): ReferentieItem[] {
  return dedupeReferentieItems(data[soort] ?? []);
}

export function listReferentieSoorten(): string[] {
  return Object.keys(data).sort((a, b) => a.localeCompare(b));
}
