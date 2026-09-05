// SPDX-License-Identifier: BUSL-1.1
/**
 * Loads authoring entities + every authored `authorizationConfig` from disk and
 * emits one Keycloak realm-export JSON per realm. Mirrors the shape of
 * `generate-ui-artifacts.ts` so the main compiler entrypoint can collect both
 * kinds of artifacts.
 *
 * Output is registered as compiler-owned via
 * `packages/compiler/src/generated-artifact-paths.ts` (root: `keycloak/`).
 */
// @ts-nocheck
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
  generateAllKeycloakRealmArtifacts,
  type KeycloakRealmArtifact,
} from "./generators/keycloak.js";
import type { CompiledEntityContract } from "./types/compiled.js";
import type { AuthorizationConfigFile } from "./types/authoring.js";
import { AUTHORIZATION_FILENAME_RE } from "./authorization-patch.js";

/**
 * Filenames read as realm authoring: `authorization.yaml` and any
 * `authorization.<something>.yaml` beside it.
 *
 * A NAMING convention rather than a directory scan for `kind:
 * authorizationConfig`, because the resolved authoring tree root also holds
 * documents this generator has no business parsing, and because the layer
 * resolver merges by relative path — a convention that is visible in the
 * filename is one an overlay author can predict. `authorization.yaml` keeps its
 * exact name: it is the tenant realm, cited by that name across docs, the web
 * generator's runtime metadata, and the e2e setup.
 *
 * The pattern itself lives in authorization-patch.ts (imported above) so a
 * patch's `isAuthorizationFilePath` and this generator's discovery can never
 * drift apart — they used to be two copies of the same regex.
 */

/**
 * Every authored realm config, in filename order.
 *
 * Sorted so the emitted artifact list is deterministic regardless of what
 * order the filesystem happens to enumerate in — `check:generated` hashes two
 * consecutive generations and fails on any difference.
 */
function loadAuthorizationConfigs(authoringDir: string): AuthorizationConfigFile[] {
  if (!existsSync(authoringDir)) {
    return [];
  }
  const configs: AuthorizationConfigFile[] = [];
  for (const entry of readdirSync(authoringDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isFile() || !AUTHORIZATION_FILENAME_RE.test(entry.name)) {
      continue;
    }
    const path = join(authoringDir, entry.name);
    const parsed = YAML.parse(readFileSync(path, "utf8")) as AuthorizationConfigFile | null;
    if (parsed?.kind !== "authorizationConfig") {
      // The name reserves the slot; a document that does not fill it is a
      // mistake worth naming, not a file to skip. Skipping is how a renamed
      // `kind` turns into a realm that quietly stops being generated.
      throw new Error(
        `${path} is named as realm authoring but declares kind ` +
          `"${parsed?.kind ?? "(none)"}" instead of "authorizationConfig".`,
      );
    }
    configs.push(parsed);
  }
  return configs;
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
  const authConfigs = loadAuthorizationConfigs(authoringDir);
  if (authConfigs.length === 0) {
    return [];
  }
  // Entities are compiled ONCE and shared across realms. Only a realm that
  // names an `entityRoleClient` consumes them; the rest see the same contracts
  // and derive nothing from them.
  const contracts = compileAllEntities(authoringDir);
  return generateAllKeycloakRealmArtifacts(contracts, authConfigs);
}
