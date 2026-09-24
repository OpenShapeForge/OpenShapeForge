// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { buildMcp, deriveToolPrefix } from "./mcp.js";
import type { CoreEntity } from "../types.js";

const actions = ["list", "get", "create", "update", "delete"] as const;

const entity = (tools?: "dedicated" | "generic"): CoreEntity => ({
  schemaVersion: 3,
  kind: "coreEntity",
  module: "core",
  entity: "ContactDetail",
  title: "Contact Detail",
  language: "en",
  fields: [{ key: "value", osfType: "string", baseType: "string" }],
  operations: Object.fromEntries(actions.map((action) => [action, {
    name: action,
    description: `${action} contact details`,
    implementation: { type: "entity", action },
    effects: {
      data: action === "list" || action === "get" ? "read" : action === "delete" ? "delete" : "write",
      external: "none",
    },
    reliability: { idempotency: { mode: "natural" } },
    confirmation: { mode: "none" },
  }])),
  interfaces: { mcp: { ...(tools ? { tools } : {}) } },
}) as CoreEntity;

describe("deriveToolPrefix", () => {
  it("snake-cases the entity name", () => {
    expect(deriveToolPrefix("ContactDetail")).toBe("contact_detail");
    expect(deriveToolPrefix("RelationGroup")).toBe("relation_group");
  });
});

describe("buildMcp", () => {
  it("fails closed without interfaces.mcp", () => {
    const value = entity();
    delete value.interfaces!.mcp;
    expect(buildMcp(value)).toBeUndefined();
  });

  it("derives the prefix, style and canonical Operation set", () => {
    expect(buildMcp(entity())).toMatchObject({
      toolPrefix: "contact_detail",
      tools: "dedicated",
      operations: { list: true, get: true, create: true, update: true, delete: true },
    });
    expect(buildMcp(entity("generic"))?.tools).toBe("generic");
  });

  it("round-trips explicit canonical Operation MCP names and instructions", () => {
    const value = entity();
    value.interfaces!.mcp!.operations = {
      get: { name: "read_contact_detail", instructions: { en: "Use the exact id." } },
      update: false,
    };
    const section = buildMcp(value);
    expect(section?.operations).toEqual({
      list: true,
      get: true,
      create: true,
      update: false,
      delete: true,
    });
    expect(section?.toolOverrides).toEqual({ get: { name: "read_contact_detail" } });
    expect(section?.operationInstructions).toEqual({ get: { en: "Use the exact id." } });
  });

  it("rejects names outside the supported dedicated projection", () => {
    const generic = entity("generic");
    generic.interfaces!.mcp!.operations = { get: { name: "read_contact" } };
    expect(() => buildMcp(generic)).toThrow(/generic tool style/);

    const unsafe = entity();
    unsafe.interfaces!.mcp!.operations = { get: { name: "Bad Name" } };
    expect(() => buildMcp(unsafe)).toThrow(/Unsafe interfaces\.mcp tool name/);
  });

  it("validates and carries the supported resource projection", () => {
    const value = entity();
    value.interfaces!.mcp!.resource = { uri: "app://contact-details", name: "Contacts" };
    expect(buildMcp(value)?.resource).toEqual({ uri: "app://contact-details", name: "Contacts" });
    value.interfaces!.mcp!.resource = { uri: "app://contact-details/{id}" };
    expect(() => buildMcp(value)).toThrow(/Unsafe interfaces\.mcp resource uri/);
  });

  it("lowers canonical secure input into the existing secure handoff metadata", () => {
    const value = entity();
    value.fields = [
      { key: "providerId", osfType: "string", baseType: "string" },
      { key: "secretValues", osfType: "object", baseType: "object" },
    ];
    value.operations!.create!.interaction = {
      type: "secureInput",
      sourceField: "providerId",
      sourceEntity: "Provider",
      definitionsField: "configurationFields",
      into: "secretValues",
      message: "Enter values securely.",
    };
    expect(buildMcp(value)?.elicitOnCreate).toEqual({
      sourceField: "providerId",
      sourceEntity: "Provider",
      definitionsField: "configurationFields",
      into: "secretValues",
      message: "Enter values securely.",
    });
  });
});
