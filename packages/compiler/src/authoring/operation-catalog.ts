// SPDX-License-Identifier: BUSL-1.1
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { OperationCatalogDefinition } from "./types.js";
import { authoringValidator } from "./schema-validation.js";

export type LoadedOperationCatalog = {
  path: string;
  document: OperationCatalogDefinition;
};

/**
 * The canonical id a catalog operation is registered under. Authors may pin
 * it with `id`; otherwise it is `<plugin>.<key>`. The compiler keys the static
 * registry on this and the web manifest joins the authored catalog back to the
 * compiled contract with it, so both derive it here rather than each guessing.
 */
export function moduleOperationId(
  catalog: Pick<OperationCatalogDefinition, "plugin">,
  key: string,
  definition: Pick<OperationCatalogDefinition["operations"][string], "id">,
): string {
  return definition.id ?? `${catalog.plugin}.${key}`;
}

/**
 * Web placement invariants the JSON schema cannot state: a placement must name
 * an operation and a page that exist, an empty page would be a dead menu
 * entry, and a landing operation runs unprompted on page open, so it must be a
 * read that needs no input and there can be only one per page.
 */
function assertWebInterface(path: string, catalog: OperationCatalogDefinition): void {
  const web = catalog.interfaces.web;
  if (!web) return;
  const landingByPage = new Map<string, string>();
  const populatedPages = new Set<string>();
  for (const [key, placement] of Object.entries(web.operations)) {
    const operation = catalog.operations[key];
    if (!operation) {
      throw new Error(`${path} interfaces.web places unknown operation "${key}".`);
    }
    if (!web.pages[placement.page]) {
      throw new Error(
        `${path} interfaces.web places operation "${key}" on unknown page "${placement.page}".`,
      );
    }
    populatedPages.add(placement.page);
    if (!placement.landing) continue;
    const required = operation.input?.schema.required;
    if (operation.effects.data !== "read" || (Array.isArray(required) && required.length > 0)) {
      throw new Error(
        `${path} landing operation "${key}" must be a read operation without required input; ` +
          "it runs unprompted when its page opens.",
      );
    }
    const previous = landingByPage.get(placement.page);
    if (previous) {
      throw new Error(
        `${path} page "${placement.page}" has two landing operations ("${previous}" and "${key}"); ` +
          "only one operation can run on page open.",
      );
    }
    landingByPage.set(placement.page, key);
  }
  for (const page of Object.keys(web.pages)) {
    if (!populatedPages.has(page)) {
      throw new Error(`${path} interfaces.web page "${page}" has no operations.`);
    }
  }
}

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
      if (operation.implementation.action) {
        throw new Error(
          `${path} module operation "${key}" cannot claim entity CRUD action ` +
            `"${operation.implementation.action}".`,
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
      // A control-realm operator has no tenant; a tenancy that asks for one
      // would make the operation unreachable rather than wrong.
      if (operation.auth?.mode === "control" && operation.tenancy?.mode !== "none") {
        throw new Error(
          `${path} module operation "${key}" uses control auth and so must declare tenancy mode none.`,
        );
      }
    }
    assertWebInterface(path, catalog);
    return { path, document: catalog };
  });
}
