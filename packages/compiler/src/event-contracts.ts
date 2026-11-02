// SPDX-License-Identifier: BUSL-1.1
/** Compiled event value contracts. This describes payloads, not event delivery. */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { authoringValidator } from "./authoring/schema-validation.js";
import { runtimeFieldSchemaRegistry } from "./field-json-schema.js";
import { operationFieldObjectSchema, resolveFields, type OperationFieldDefinition, type ResolvedOperationField } from "@openshapeforge/operations";
import type { FieldDefinition, OsfTypeDefinition } from "./authoring/types.js";
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

// Entity write-path behavior has no event execution semantics. Walk semantic
// shapes too: they may contribute fields that were not authored inline.
const EVENT_FIELD_KEYS = new Set([
  "key", "osfType", "cardinality", "required", "label", "description", "help", "unit",
  "defaultValue", "validation", "options", "shape", "children", "item", "document",
]);
function assertEventFields(fields: readonly FieldDefinition[], osfTypes: Record<string, OsfTypeDefinition>, origin: string, active = new Set<string>()): void {
  for (const field of fields) {
    if (Object.keys(field).some(key => !EVENT_FIELD_KEYS.has(key)) || field.osfType === "typedValue") {
      throw new Error(`${origin}: event field ${field.key} uses unsupported entity or presentation behavior.`);
    }
    if (field.children) assertEventFields(field.children, osfTypes, origin, active);
    if (field.shape) assertEventFields(field.shape, osfTypes, origin, active);
    if (field.item) assertEventFields([field.item], osfTypes, origin, active);
    const semantic = osfTypes[field.osfType];
    if (semantic && !active.has(field.osfType)) {
      const next = new Set(active).add(field.osfType);
      if (semantic.children) assertEventFields(semantic.children, osfTypes, origin, next);
      if (semantic.shape) assertEventFields(semantic.shape, osfTypes, origin, next);
      if (semantic.item) assertEventFields([semantic.item], osfTypes, origin, next);
    }
  }
}

// A schema must not suggest that document policy or unspecified object content
// is validated when the shared field projector does not enforce either.
function assertSupported(fields: readonly ResolvedOperationField[], origin: string): void {
  for (const field of fields) {
    if (field.document) throw new Error(`${origin}: document policy on ${field.key} is not yet supported for event contracts.`);
    if (field.baseType === "object" && !field.children?.length && !field.schema && !field.item) {
      throw new Error(`${origin}: object field ${field.key} needs a declared shape or semantic schema.`);
    }
    if (field.children) assertSupported(field.children, origin);
    if (field.item) assertSupported([field.item], origin);
  }
}

/** Validate, normalize and project with the same compiler as all other OSF fields. */
export function compileEventContract(
  definition: EventContractDefinition,
  input: { osfTypes?: Record<string, OsfTypeDefinition>; referentiedata?: CoreReferentiedataSnapshot },
  origin = "event contract",
): CompiledEventContract {
  if (!definition || definition.kind !== "eventContract") throw new Error(`${origin}: expected kind eventContract.`);
  authoringValidator().validate(definition, origin);
  const fields = structuredClone(definition.fields);
  assertEventFields(fields, input.osfTypes ?? {}, origin);
  // UI renderer selection is not part of an event value contract.
  const osfTypes = Object.fromEntries(Object.entries(input.osfTypes ?? {}).map(([key, value]) => {
    const { render: _render, ...semantic } = value;
    return [key, semantic];
  }));
  const registry = runtimeFieldSchemaRegistry({ ...input, osfTypes });
  const operationFields = fields as unknown as readonly OperationFieldDefinition[];
  assertSupported(resolveFields(operationFields, registry), origin);
  const schema = operationFieldObjectSchema(operationFields, registry);
  const contract = { event: definition.event, version: definition.version, fields, schema };
  return { ...contract, checksum: createHash("sha256").update(canonical(contract)).digest("hex") };
}

/** Load all event contract documents from the resolved authoring layer. */
export function loadEventContracts(authoringDir: string, input: {
  osfTypes?: Record<string, OsfTypeDefinition>;
  referentiedata?: CoreReferentiedataSnapshot;
}): CompiledEventContract[] {
  const root = join(authoringDir, "event-contracts");
  try {
    if (lstatSync(root).isSymbolicLink()) throw new Error(`${root}: symbolic links are not supported in event contract authoring.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error(`${join(dir, entry.name)}: symbolic links are not supported in event contract authoring.`);
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
