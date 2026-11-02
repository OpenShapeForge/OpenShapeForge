// SPDX-License-Identifier: BUSL-1.1
/** Compiled event value contracts. This describes payloads, not event delivery. */
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { authoringValidator } from "./authoring/schema-validation.js";
import { createFieldSchemaCompiler } from "./field-json-schema.js";
import type { ComponentCatalog, FieldDefinition, OsfTypeDefinition } from "./authoring/types.js";
import type { CoreReferentiedataSnapshot } from "./core-referentiedata-artifacts.js";

export type EventContractDefinition = {
  schemaVersion: 1;
  kind: "eventContract";
  event: string;
  version: number;
  fields: FieldDefinition[];
};

export type CompiledEventContract = {
  event: string;
  version: number;
  fields: FieldDefinition[];
  schema: Record<string, unknown>;
  /** Hash of the identity, authored fields and resolved schema, not a compatibility promise. */
  checksum: string;
};

// Sort object keys recursively to make content identities independent of YAML key order.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Event contract contains a non-JSON value.");
  return encoded;
}

function assertUniqueFields(fields: readonly FieldDefinition[], origin: string): void {
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.key)) throw new Error(`${origin}: duplicate event field ${field.key}.`);
    seen.add(field.key);
    if (field.children) assertUniqueFields(field.children, origin);
    if (field.shape) assertUniqueFields(field.shape, origin);
    if (field.item) assertUniqueFields([field.item], origin);
  }
}

/** Validate, normalize and project with the same compiler as all other OSF fields. */
export function compileEventContract(
  definition: EventContractDefinition,
  input: { componentCatalog: ComponentCatalog; osfTypes?: Record<string, OsfTypeDefinition>; referentiedata?: CoreReferentiedataSnapshot },
  origin = "event contract",
): CompiledEventContract {
  authoringValidator().validate(definition, origin);
  assertUniqueFields(definition.fields, origin);
  const fields = structuredClone(definition.fields);
  const schema = createFieldSchemaCompiler(input).object(fields);
  const contract = { event: definition.event, version: definition.version, fields, schema };
  return { ...contract, checksum: createHash("sha256").update(canonical(contract)).digest("hex") };
}

/** Load all event contract documents from the resolved authoring layer. */
export function loadEventContracts(authoringDir: string, input: {
  componentCatalog: ComponentCatalog;
  osfTypes?: Record<string, OsfTypeDefinition>;
  referentiedata?: CoreReferentiedataSnapshot;
}): CompiledEventContract[] {
  const root = join(authoringDir, "event-contracts");
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) files.push(join(dir, entry.name));
    }
  };
  walk(root);
  const contracts = files.map(path => {
    const { document } = authoringValidator().validateFile(path, path);
    return compileEventContract(document as EventContractDefinition, input, path);
  });
  const seen = new Set<string>();
  for (const contract of contracts) {
    const id = `${contract.event}@${contract.version}`;
    if (seen.has(id)) throw new Error(`Duplicate event contract ${id}.`);
    seen.add(id);
  }
  return contracts.sort((a, b) => a.event.localeCompare(b.event) || a.version - b.version);
}
