#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  generateAuthoringUiArtifacts,
} from "./authoring/generate-ui-artifacts.js";
import { generateAuthoringKeycloakArtifacts } from "./authoring/generate-keycloak-artifacts.js";
import {
  activeManifestSource,
  loadActivePlatformCompile,
  resolveActiveAuthoringDir,
} from "./active-manifest.js";
import { generateCoreReferentiedataArtifacts } from "./core-referentiedata-artifacts.js";
import { generateArtifacts } from "./generate.js";
import type { GeneratedArtifact } from "./schema.js";

const defaultRepoRoot = resolve(import.meta.dir, "../../..");

export type ArtifactCollection = {
  groups: {
    db: GeneratedArtifact[];
    referentiedata: GeneratedArtifact[];
    ui: GeneratedArtifact[];
    keycloak: GeneratedArtifact[];
    plugins: { name: string; artifacts: GeneratedArtifact[] }[];
  };
  all: GeneratedArtifact[];
  /** Plugin-owned output paths, merged into the check gates. */
  ownedPaths: { roots: string[]; files: string[] };
};

/**
 * Collects every artifact the compiler would write, without touching disk.
 * The single entry point shared by `runCompiler` and the check scripts.
 */
export async function collectAllArtifacts(
  repoRoot: string = defaultRepoRoot,
): Promise<ArtifactCollection> {
  const { manifest, entities, plugins } = await loadActivePlatformCompile(repoRoot);
  const authoringDir = resolveActiveAuthoringDir(repoRoot);
  // Web UI artifacts (CRUD pages, entity manifests, actions, workflow
  // contract) are only generated when the repo actually has a web app. A
  // data-layer + API repo skips them entirely; adding apps/web back
  // re-enables generation without compiler changes.
  const webPresent = existsSync(join(repoRoot, "apps/web"));
  const groups: ArtifactCollection["groups"] = {
    db: generateArtifacts(manifest, { source: activeManifestSource }),
    referentiedata: await generateCoreReferentiedataArtifacts(repoRoot),
    ui: webPresent ? await generateAuthoringUiArtifacts(authoringDir) : [],
    keycloak: generateAuthoringKeycloakArtifacts(authoringDir),
    plugins: [],
  };

  const context = { repoRoot, authoringDir, webPresent, manifest, entities };
  for (const plugin of plugins) {
    if (plugin.generate) {
      groups.plugins.push({ name: plugin.name, artifacts: await plugin.generate(context) });
    }
  }

  const all = [
    ...groups.db,
    ...groups.referentiedata,
    ...groups.ui,
    ...groups.keycloak,
    ...groups.plugins.flatMap((entry) => entry.artifacts),
  ];
  const seenPaths = new Set<string>();
  for (const artifact of all) {
    if (seenPaths.has(artifact.path)) {
      throw new Error(`Artifact path collision: ${artifact.path} emitted twice.`);
    }
    seenPaths.add(artifact.path);
  }

  return {
    groups,
    all,
    ownedPaths: {
      roots: plugins.flatMap((plugin) => plugin.ownedPaths?.roots ?? []),
      files: plugins.flatMap((plugin) => plugin.ownedPaths?.files ?? []),
    },
  };
}

export type RunCompilerOptions = {
  /** Host repo root; defaults to this package's own monorepo root. */
  repoRoot?: string;
};

export async function runCompiler(options: RunCompilerOptions = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const { all } = await collectAllArtifacts(repoRoot);

  for (const artifact of all) {
    const target = join(repoRoot, artifact.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, artifact.contents, "utf8");
  }

  return all.map((artifact) => artifact.path);
}

if (import.meta.main) {
  // Host repos run `openshapeforge-compiler --repo-root .` (or set
  // OPENSHAPEFORGE_REPO_ROOT); without either, the compiler assumes it lives at
  // <repoRoot>/packages/compiler inside its own monorepo.
  const flagIndex = process.argv.indexOf("--repo-root");
  const repoRoot =
    flagIndex >= 0
      ? resolve(process.argv[flagIndex + 1] ?? ".")
      : process.env.OPENSHAPEFORGE_REPO_ROOT
        ? resolve(process.env.OPENSHAPEFORGE_REPO_ROOT)
        : undefined;
  const paths = await runCompiler(repoRoot ? { repoRoot } : {});
  for (const path of paths) {
    console.log(`generated ${path}`);
  }
}
