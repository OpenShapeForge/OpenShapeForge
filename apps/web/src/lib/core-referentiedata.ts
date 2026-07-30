// SPDX-License-Identifier: BUSL-1.1
import byGroep from "./core-referentiedata-by-groep.json";

export type ReferentieItem = {
  value: string;
  label: { nl: string; en: string };
};

type ByGroep = Record<string, ReferentieItem[]>;

const data = byGroep as ByGroep;

/**
 * Core referentiedata snapshot (Groep -> codes/labels). Canonical source lives
 * in `packages/compiler/config/authoring/catalogs/core-referentiedata.yaml`;
 * this file is the web-runtime JSON copy.
 */
export function getCoreReferentieItemsForGroep(groep: string): ReferentieItem[] {
  return data[groep] ?? [];
}

export function listCoreReferentieGroepen(): string[] {
  return Object.keys(data).sort((a, b) => a.localeCompare(b));
}
