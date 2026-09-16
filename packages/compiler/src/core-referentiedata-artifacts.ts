// SPDX-License-Identifier: BUSL-1.1
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { resolveActiveAuthoringDir } from "./active-manifest.js";
import type { GeneratedArtifact } from "./schema.js";

type CatalogItem = {
  value: string;
  label?: Partial<Record<"nl" | "en" | "fr", string>>;
};

type CatalogGroup = {
  items?: CatalogItem[];
};

type CoreCatalog = {
  groepen?: Record<string, CatalogGroup>;
};

type SnapshotItem = {
  value: string;
  label: { nl: string; en: string };
};

type Snapshot = Record<string, SnapshotItem[]>;

const catalogRelativePath = "catalogs/core-referentiedata.yaml";

export const coreReferentiedataArtifactPaths = [
  "packages/compiler/config/referentiedata/core-by-groep.json",
  "apps/web/src/lib/core-referentiedata-by-groep.json",
] as const;

function requireLabel(
  item: CatalogItem,
  groupName: string,
  locale: "nl" | "en",
): string {
  const value = item.label?.[locale]?.trim();
  if (value) {
    return value;
  }
  const fallback = item.label?.nl?.trim() || item.label?.en?.trim();
  if (fallback) {
    return fallback;
  }
  throw new Error(
    `Core referentiedata group "${groupName}" item "${item.value}" is missing labels.`,
  );
}

function buildSnapshot(catalog: CoreCatalog): Snapshot {
  const groups = catalog.groepen ?? {};
  const snapshotEntries = Object.entries(groups).map(([groupName, group]) => {
    const items = (group.items ?? []).map((item) => {
      if (typeof item.value !== "string" || item.value.trim().length === 0) {
        throw new Error(
          `Core referentiedata group "${groupName}" contains an item without a value.`,
        );
      }
      return {
        value: item.value,
        label: {
          nl: requireLabel(item, groupName, "nl"),
          en: requireLabel(item, groupName, "en"),
        },
      };
    });
    return [groupName, items] as const;
  });

  return Object.fromEntries(snapshotEntries);
}

export type CoreReferentiedataSnapshot = Snapshot;

/**
 * The snapshot as a value, built from the authoring catalog.
 *
 * Generators must consume THIS rather than reading the emitted
 * `core-by-groep.json`: within a single compile the file on disk is still the
 * previous run's, because artifacts are written only after every generator has
 * produced its contents. A generator that read the file would therefore expand
 * a newly added group only on the SECOND `bun run generate` — deterministic,
 * but stale by one run and baffling to whoever added the group.
 */
export async function loadCoreReferentiedataSnapshot(
  repoRoot: string,
): Promise<Snapshot> {
  // Read through the resolved authoring layers so overlay catalog merges
  // (e.g. extra referentiedata groups) flow into the snapshot.
  const rawCatalog = await readFile(
    join(resolveActiveAuthoringDir(repoRoot), catalogRelativePath),
    "utf8",
  );
  return buildSnapshot(YAML.parse(rawCatalog) as CoreCatalog);
}

export async function generateCoreReferentiedataArtifacts(
  repoRoot: string,
  snapshot?: Snapshot,
): Promise<GeneratedArtifact[]> {
  const resolved = snapshot ?? (await loadCoreReferentiedataSnapshot(repoRoot));
  const contents = `${JSON.stringify(resolved, null, 2)}\n`;

  // The apps/web copy only exists in repos that have a web app; a data-layer
  // only repo gets just the compiler-config snapshot.
  const webPresent = existsSync(join(repoRoot, "apps/web"));
  return coreReferentiedataArtifactPaths
    .filter((path) => webPresent || !path.startsWith("apps/web/"))
    .map((path) => ({
      path,
      contents,
    }));
}
