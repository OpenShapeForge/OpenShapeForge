// SPDX-License-Identifier: BUSL-1.1
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { RuntimeFieldSchemaCompiler, ModuleSeed } from "@openshapeforge/plugin-runtime";
import { query, type Executor } from "./sql.js";

export type PreferenceDefinition = { namespace: string; field: Record<string, unknown> & { key: string } };

/** Host supplies its composed plugin fixture paths. Fields use the canonical schema unchanged. */
export function loadPreferenceDefinitions(files: readonly string[], schemas: RuntimeFieldSchemaCompiler): PreferenceDefinition[] {
  const result: PreferenceDefinition[] = [];
  const keys = new Set<string>();
  for (const file of files) {
    const fixture = parse(readFileSync(file, "utf8"));
    if (!fixture || fixture.kind !== "preferenceDefinitions") continue;
    if (fixture.version !== 1 || !Array.isArray(fixture.preferences) || Object.keys(fixture).some((key) => !["kind", "version", "preferences"].includes(key))) throw new Error("Invalid preference fixture.");
    for (const definition of fixture.preferences) {
      if (!definition || Object.keys(definition).some((key) => !["namespace", "field"].includes(key)) || typeof definition.namespace !== "string" || !/^[a-z][a-z0-9.-]{0,119}$/.test(definition.namespace)) throw new Error("Invalid preference namespace.");
      schemas.object([definition.field]);
      const field = definition.field;
      const id = `${definition.namespace}:${field.key}`;
      if (keys.has(id)) throw new Error(`Duplicate preference definition: ${id}`);
      keys.add(id);
      if (Object.hasOwn(field, "defaultValue")) {
        const checked = schemas.validateObject([field], { [field.key]: field.defaultValue });
        if (!checked.valid) throw new Error(`Invalid preference default: ${id}`);
      }
      result.push({ namespace: definition.namespace, field });
    }
  }
  return result.sort((a, b) => `${a.namespace}:${a.field.key}`.localeCompare(`${b.namespace}:${b.field.key}`, "en"));
}

/** Run only from the host's managed seed transaction, never from a user operation. */
export async function seedPreferenceDefinitions(database: unknown, definitions: readonly PreferenceDefinition[]) {
  const db = database as Executor;
  for (const definition of definitions) {
    await db.executeQuery(query(`insert into platform.preference_definitions (namespace, key, definition)
      values ($1, $2, $3::text::jsonb) on conflict (namespace, key) do update set definition = excluded.definition`,
    [definition.namespace, definition.field.key, JSON.stringify(definition.field)]));
  }
  // Retired definitions stop being offered immediately; private overrides remain
  // available if the same definition is deliberately installed again later.
  await db.executeQuery(query(`delete from platform.preference_definitions as definition
    where not exists (select 1 from jsonb_array_elements_text($1::text::jsonb) as active(key)
      where active.key = (definition.namespace || ':' || definition.key))`, [JSON.stringify(definitions.map((entry) => `${entry.namespace}:${entry.field.key}`))]));
  return { definitions: definitions.length };
}

export const preferenceDefinitionsSeed: ModuleSeed = {
  name: "personalPreferenceDefinitions",
  async apply(db, context) {
    if (!context?.schemas) throw new Error("Personal preference seeds require canonical field schema services.");
    const directory = context.seedDirectory ?? fileURLToPath(new URL("../authoring/seeds/", import.meta.url));
    const paths = existsSync(directory) ? readdirSync(directory).filter((name) => /\.(json|ya?ml)$/.test(name)).sort().map((name) => join(directory, name)) : [];
    const definitions = loadPreferenceDefinitions(paths, context.schemas.fields);
    await db.transaction().execute((transaction) => seedPreferenceDefinitions(transaction, definitions));
    return { present: true, skipped: false, rows: definitions.length };
  },
};
