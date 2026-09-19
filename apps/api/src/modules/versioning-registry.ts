// SPDX-License-Identifier: BUSL-1.1
/**
 * The published-snapshot bindings the compiler wrote into the generated
 * manifest (`tables[].source.versioning.storage`), served to the versioning
 * runtime through `platform.schemas.versioning`. The runtime executes against
 * these exact schema and table names; nothing here is derived from an entity
 * name, so a plugin entity in its own schema binds like a core one.
 */
import { readFileSync } from "node:fs";
import type { RuntimeVersioningBinding, RuntimeVersioningRegistry } from "@openshapeforge/plugin-runtime";

const identifier = /^[a-z_][a-z0-9_]*$/;
const entityName = /^[A-Z][A-Za-z0-9]*$/;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const matches = (value: unknown, pattern: RegExp): boolean => typeof value === "string" && pattern.test(value);
const invalid = (): never => { throw new Error("The generated versioning registry is invalid."); };

/** Accepts generated manifest tables only, never authored or tenant input. */
export function createVersioningRegistry(tables: unknown): RuntimeVersioningRegistry {
  if (!Array.isArray(tables)) invalid();
  const bindings = new Map<string, RuntimeVersioningBinding>();
  for (const table of tables as unknown[]) {
    if (!record(table) || !record(table.source)) continue;
    const versioning: unknown = table.source.versioning;
    if (versioning === undefined) continue;
    if (!record(versioning) || !matches(table.source.authoringEntityName, entityName) ||
        !matches(versioning.versionEntity, entityName) || !record(versioning.storage) ||
        !record(versioning.storage.head) || !record(versioning.storage.version)) invalid();
    const storage = (versioning as Record<string, unknown>).storage as { head: Record<string, unknown>; version: Record<string, unknown> };
    if (![storage.head.schema, storage.head.table, storage.version.schema, storage.version.table, storage.version.headColumn]
      .every((name) => matches(name, identifier))) invalid();
    // The head binding is the table it sits on; a mismatch means the manifest was assembled wrong.
    if (storage.head.schema !== table.schema || storage.head.table !== table.table) invalid();
    const sourceEntity = table.source.authoringEntityName as string;
    if (bindings.has(sourceEntity)) invalid();
    bindings.set(sourceEntity, Object.freeze({
      sourceEntity,
      versionEntity: (versioning as Record<string, unknown>).versionEntity as string,
      head: Object.freeze({ schema: storage.head.schema as string, table: storage.head.table as string }),
      version: Object.freeze({
        schema: storage.version.schema as string, table: storage.version.table as string, headColumn: storage.version.headColumn as string,
      }),
    }));
  }
  return Object.freeze({ get: (sourceEntity: string) => bindings.get(sourceEntity) });
}

let generated: RuntimeVersioningRegistry | undefined;
function readGenerated(): RuntimeVersioningRegistry {
  if (!generated) {
    const manifest = JSON.parse(readFileSync(new URL("../generated/db/manifest.json", import.meta.url), "utf8")) as Record<string, unknown>;
    generated = createVersioningRegistry(manifest.tables ?? []);
  }
  return generated;
}
export const generatedVersioning: RuntimeVersioningRegistry = Object.freeze({
  get: (sourceEntity) => readGenerated().get(sourceEntity),
});
