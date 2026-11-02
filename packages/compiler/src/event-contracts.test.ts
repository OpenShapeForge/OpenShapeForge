// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { compileEventContract, loadEventContracts, type EventContractDefinition } from "./event-contracts.js";
import type { ComponentCatalog, OsfTypeDefinition } from "./authoring/types.js";

const componentCatalog: ComponentCatalog = {
  schemaVersion: 1, kind: "componentCatalog",
  defaults: { string: { component: "Input" }, object: { component: "ObjectEditor" }, collection: { component: "CollectionEditor" } },
  viewDefaults: {}, components: {},
};
const osfTypes: Record<string, OsfTypeDefinition> = {
  richDocument: {
    label: { en: "Rich document" }, baseType: "object",
    schema: { oneOf: [
      { type: "string" },
      { type: "object", properties: { format: { const: "example" }, value: { type: "object" } }, required: ["format", "value"], additionalProperties: false },
    ] },
  },
};
const input = { componentCatalog, osfTypes };
const ticket: EventContractDefinition = {
  schemaVersion: 1, kind: "eventContract", event: "ticket.created", version: 1,
  fields: [
    { key: "ticket", osfType: "object", required: true, children: [
      { key: "externalId", osfType: "string", required: true },
      { key: "description", osfType: "richDocument" },
      { key: "labels", osfType: "string", cardinality: "collection" },
    ] },
  ],
};

describe("event value contracts", () => {
  it("projects canonical fields, preserving both rich text forms", () => {
    const result = compileEventContract(ticket, input);
    expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);
    const validate = new Ajv2020.default({ strict: false }).compile(result.schema);
    expect(validate({ ticket: { externalId: "1", description: "text", labels: ["a"] } })).toBe(true);
    expect(validate({ ticket: { externalId: "1", description: { format: "example", value: { blocks: [] } } } })).toBe(true);
    expect(validate({ ticket: { description: "text" } })).toBe(false);
    expect(validate({ ticket: { externalId: "1", description: 17 } })).toBe(false);
    expect(validate({ ticket: { externalId: "1", unknown: true } })).toBe(false);
  });
  it("identifies exactly the content and version deterministically", () => {
    const a = compileEventContract(ticket, input);
    const b = compileEventContract(structuredClone(ticket), input);
    expect(a).toEqual(b);
    expect(compileEventContract({ ...ticket, version: 2 }, input).checksum).not.toBe(a.checksum);
    expect(compileEventContract({ ...ticket, fields: [{ key: "id", osfType: "string" }] }, input).checksum).not.toBe(a.checksum);
  });
  it("rejects invalid identities, unknown properties, unsafe fields and duplicate nested fields", () => {
    expect(() => compileEventContract({ ...ticket, event: "ticket" }, input)).toThrow();
    expect(() => compileEventContract({ ...ticket, version: 0 }, input)).toThrow();
    expect(() => compileEventContract({ ...ticket, extra: true } as EventContractDefinition, input)).toThrow();
    expect(() => compileEventContract({ ...ticket, fields: [{ key: "__proto__", osfType: "string" }] }, input)).toThrow();
    expect(() => compileEventContract({ ...ticket, fields: [{ key: "x", osfType: "object", children: [{ key: "id", osfType: "string" }, { key: "id", osfType: "string" }] }] }, input)).toThrow(/duplicate/);
  });
  it("loads resolved authoring deterministically and rejects duplicate identity/version", () => {
    const dir = mkdtempSync(join(tmpdir(), "osf-event-contract-"));
    try {
      const path = join(dir, "event-contracts"); mkdirSync(path);
      writeFileSync(join(path, "b.yaml"), JSON.stringify(ticket));
      writeFileSync(join(path, "a.yaml"), JSON.stringify({ ...ticket, event: "email.received" }));
      expect(loadEventContracts(dir, input).map(x => x.event)).toEqual(["email.received", "ticket.created"]);
      writeFileSync(join(path, "copy.yaml"), JSON.stringify(ticket));
      expect(() => loadEventContracts(dir, input)).toThrow(/Duplicate event contract/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
