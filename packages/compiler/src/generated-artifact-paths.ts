// SPDX-License-Identifier: BUSL-1.1
/**
 * Single source of truth for filesystem paths owned by `bun run generate`.
 *
 * Keep this in the compiler package so tests and scripts can share the same
 * ownership boundary without duplicating path lists.
 */
export const compilerOwnedGeneratedRoots = [
  "apps/api/src/generated/db",
  // NOTE: workflow-generated roots (apps/api/src/generated/workflow, the web
  // workflow/renderer feature roots) are owned by the example workflow plugin
  // (examples/plugins/workflow) via its `ownedPaths.roots` — the check scripts
  // merge plugin-owned paths into the same stale/orphan gates.
  "apps/web/src/actions/generated",
  "apps/web/src/app/(generated)",
  "apps/web/src/compiler",
  "apps/web/src/generated",
  // Keycloak realm export — emitted by
  // `packages/compiler/src/authoring/generators/keycloak.ts`
  // and mounted into the local Keycloak container by
  // `docker-compose.local.yml`. The file `keycloak/openshapeforge-dev-realm.json` is
  // the only file expected under this root; orphan files cause `check:generated`
  // to fail.
  "keycloak",
];

/** Emitted next to `(generated)/` rather than under a generated directory. */
export const compilerGeneratedAppShellFiles = [
  "apps/web/src/app/layout.tsx",
  "apps/web/src/app/page.tsx",
];

/** Single-file compiler outputs outside the generated roots. */
export const compilerOwnedGeneratedFiles = [
  ...compilerGeneratedAppShellFiles,
  "packages/compiler/config/referentiedata/core-by-groep.json",
  "apps/web/src/lib/core-referentiedata-by-groep.json",
];
