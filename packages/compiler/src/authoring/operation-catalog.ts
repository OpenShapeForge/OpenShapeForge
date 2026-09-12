// SPDX-License-Identifier: BUSL-1.1
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { OperationCatalogDefinition } from "./types.js";
import { authoringValidator } from "./schema-validation.js";

export type LoadedOperationCatalog = {
  path: string;
  document: OperationCatalogDefinition;
};

export function loadOperationCatalogs(authoringDir: string): LoadedOperationCatalog[] {
  const root = join(authoringDir, "operations");
  if (!existsSync(root)) return [];
  const paths: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) paths.push(path);
    }
  };
  walk(root);
  return paths.sort().map((path) => {
    const { document } = authoringValidator().validateFile(path, path);
    const catalog = document as OperationCatalogDefinition;
    for (const [key, operation] of Object.entries(catalog.operations)) {
      if (operation.implementation.type !== "plugin") {
        throw new Error(`${path} operation "${key}" must use implementation.type plugin.`);
      }
      if (operation.implementation.plugin !== catalog.plugin) {
        throw new Error(
          `${path} operation "${key}" implementation plugin ` +
            `"${operation.implementation.plugin}" must match catalog plugin "${catalog.plugin}".`,
        );
      }
      if (operation.target) {
        throw new Error(`${path} module operation "${key}" cannot declare an entity target.`);
      }
      if (operation.auth?.mode === "session" && operation.auth.recordPermission) {
        throw new Error(
          `${path} module operation "${key}" cannot declare recordPermission without an entity record target.`,
        );
      }
      if (operation.concurrency || operation.confirmation.mode === "challenge") {
        throw new Error(
          `${path} module operation "${key}" cannot declare record concurrency or a target-bound challenge.`,
        );
      }
    }
    return { path, document: catalog };
  });
}
