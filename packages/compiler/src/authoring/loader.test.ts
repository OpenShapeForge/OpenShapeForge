// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  validateEntityContentIdentifiers,
  loadEntity,
  resolveEntityFilePath,
} from "./loader.js";
import type { CoreEntity } from "./types.js";

// Minimal well-formed core entity used as the base for mutation tests. Only the
// identifier-bearing fields matter to validateEntityContentIdentifiers.
const baseEntity = (): CoreEntity =>
  ({
    schemaVersion: 1,
    kind: "coreEntity",
    module: "test",
    entity: "Widget",
    title: "Widget",
    language: "en",
    fields: [
      { key: "id", valueType: "string" },
      { key: "displayName", valueType: "string" },
    ],
    relationships: [{ key: "owner", kind: "belongsTo", target: "User" }],
  }) as CoreEntity;

describe("validateEntityContentIdentifiers", () => {
  it("accepts a conforming entity, field keys, and relationship key/target", () => {
    expect(() =>
      validateEntityContentIdentifiers(baseEntity(), "test.yaml"),
    ).not.toThrow();
  });

  it("rejects a hostile entity name that would break out of the manifest string literal / import path", () => {
    const hostile = baseEntity();
    // The entity name becomes a JS string-literal key and import specifier in
    // entity-manifest.ts.ejs; a quote/paren sequence would inject statements.
    hostile.entity = 'Foo") ; globalThis.x=1 ; (';
    expect(() =>
      validateEntityContentIdentifiers(hostile, "hostile.yaml"),
    ).toThrow(/entity name/);
  });

  it("rejects a lowercase-initial entity name (schema pattern is ^[A-Z]...)", () => {
    const hostile = baseEntity();
    hostile.entity = "widget";
    expect(() =>
      validateEntityContentIdentifiers(hostile, "hostile.yaml"),
    ).toThrow(/entity name/);
  });

  it("rejects a hostile field key that would restructure a generated GraphQL selection set", () => {
    const hostile = baseEntity();
    // Interpolated raw into the query literal in actions.ts.ejs / pages.ts.
    hostile.fields = [{ key: "id } evil: someOtherResolver { secret", valueType: "string" }];
    expect(() =>
      validateEntityContentIdentifiers(hostile, "hostile.yaml"),
    ).toThrow(/field key/);
  });

  it("rejects a field key containing a backtick (template-literal break-out)", () => {
    const hostile = baseEntity();
    hostile.fields = [{ key: "id`;evil()", valueType: "string" }];
    expect(() =>
      validateEntityContentIdentifiers(hostile, "hostile.yaml"),
    ).toThrow(/field key/);
  });

  it("rejects a hostile field key nested inside children", () => {
    const hostile = baseEntity();
    hostile.fields = [
      {
        key: "address",
        valueType: "object",
        children: [{ key: "street } x { y", valueType: "string" }],
      },
    ] as CoreEntity["fields"];
    expect(() =>
      validateEntityContentIdentifiers(hostile, "hostile.yaml"),
    ).toThrow(/field key/);
  });

  it("rejects a hostile relationship key", () => {
    const hostile = baseEntity();
    hostile.relationships = [
      { key: "owner } x", kind: "belongsTo", target: "User" },
    ] as NonNullable<CoreEntity["relationships"]>;
    expect(() =>
      validateEntityContentIdentifiers(hostile, "hostile.yaml"),
    ).toThrow(/relationship key/);
  });

  it("rejects a hostile relationship target", () => {
    const hostile = baseEntity();
    hostile.relationships = [
      { key: "owner", kind: "belongsTo", target: 'User") ; evil ; ("' },
    ] as NonNullable<CoreEntity["relationships"]>;
    expect(() =>
      validateEntityContentIdentifiers(hostile, "hostile.yaml"),
    ).toThrow(/relationship target/);
  });
});

describe("loadEntity content validation (integration)", () => {
  // Repo root: this file lives at packages/compiler/src/authoring/loader.test.ts.
  const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
  const authoringDir = join(repoRoot, "packages/compiler/config/authoring");

  it("loads a real, conforming entity without throwing", () => {
    // `relation` is a real authoring entity under entities/core/.
    expect(resolveEntityFilePath(authoringDir, "relation")).toContain("relation");
    expect(() => loadEntity(authoringDir, "relation")).not.toThrow();
  });
});
