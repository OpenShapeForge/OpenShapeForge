// SPDX-License-Identifier: BUSL-1.1
/**
 * Loads authoring entities + authorization.yaml from disk and emits the
 * Keycloak realm-export JSON. Mirrors the shape of `generate-ui-artifacts.ts`
 * so the main compiler entrypoint can collect both kinds of artifacts.
 *
 * Output is registered as compiler-owned via
 * `packages/compiler/src/generated-artifact-paths.ts` (root: `keycloak/`).
 */
// @ts-nocheck
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import {
  discoverContextEntities,
  listEntityFiles,
  loadContextEntity,
  loadEntity,
} from "./loader.js";
import { compile } from "./compiler/index.js";
import {
  generateKeycloakRealmArtifacts,
  type KeycloakRealmArtifact,
} from "./generators/keycloak.js";
import type { CompiledEntityContract } from "./types/compiled.js";
import type { AuthorizationConfigFile } from "./types/authoring.js";

function loadAuthorizationConfig(
  authoringDir: string,
): AuthorizationConfigFile | null {
  const path = join(authoringDir, "authorization.yaml");
  if (!existsSync(path)) {
    return null;
  }
  const raw = readFileSync(path, "utf8");
  return YAML.parse(raw) as AuthorizationConfigFile;
}

function compileAllEntities(authoringDir: string): CompiledEntityContract[] {
  const compiled: CompiledEntityContract[] = [];

  // Recursive discovery via the loader — entities may live in subfolders
  // (e.g. entities/core/). listEntityFiles returns slug-sorted entries, so
  // output ordering stays deterministic.
  for (const { slug } of listEntityFiles(authoringDir)) {
    const loaded = loadEntity(authoringDir, slug);
    compiled.push(compile(loaded) as CompiledEntityContract);
  }

  const contextEntities = discoverContextEntities(authoringDir).sort((a, b) =>
    `${a.context}/${a.name}`.localeCompare(`${b.context}/${b.name}`),
  );
  for (const ce of contextEntities) {
    const loaded = loadContextEntity(authoringDir, ce.context, ce.name);
    compiled.push(compile(loaded) as CompiledEntityContract);
  }

  return compiled;
}

export function generateAuthoringKeycloakArtifacts(
  authoringDir: string,
): KeycloakRealmArtifact[] {
  const authConfig = loadAuthorizationConfig(authoringDir);
  if (!authConfig) {
    return [];
  }
  const contracts = compileAllEntities(authoringDir);
  return generateKeycloakRealmArtifacts(contracts, authConfig);
}
