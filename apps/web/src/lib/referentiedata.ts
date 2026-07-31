// SPDX-License-Identifier: BUSL-1.1
import {
  getCoreReferentieItemsForGroep,
  listCoreReferentieGroepen,
  type ReferentieItem,
} from "@/lib/core-referentiedata";
import {
  getReferentieItemsForSoort,
  listReferentieSoorten,
} from "@/lib/vera-referentiedata";

export type ReferentiedataSource = "core" | "vera" | "unknown";

export type ReferentieGroepOption = {
  value: string;
  label: string;
  description: string;
  source: Exclude<ReferentiedataSource, "unknown"> | "core+vera";
};

export function resolveReferentieGroepItems(groep: string): {
  items: ReferentieItem[];
  source: ReferentiedataSource;
} {
  const coreItems = getCoreReferentieItemsForGroep(groep);
  if (coreItems.length > 0) {
    return { items: coreItems, source: "core" };
  }

  const veraItems = getReferentieItemsForSoort(groep);
  if (veraItems.length > 0) {
    return { items: veraItems, source: "vera" };
  }

  return { items: [], source: "unknown" };
}

export function listReferentieGroepOptions(): ReferentieGroepOption[] {
  const coreGroepen = new Set(listCoreReferentieGroepen());
  const veraSoorten = new Set(listReferentieSoorten());
  const values = [...new Set([...coreGroepen, ...veraSoorten])]
    .sort((a, b) => a.localeCompare(b));

  return values.map((value) => {
    const inCore = coreGroepen.has(value);
    const inVera = veraSoorten.has(value);
    const source = inCore && inVera ? "core+vera" : inCore ? "core" : "vera";

    return {
      value,
      label: value,
      source,
      description:
        source === "core+vera"
          ? "CORE en VERA referentiedata"
          : source === "core"
            ? "CORE referentiedata"
            : "VERA referentiedata",
    };
  });
}
