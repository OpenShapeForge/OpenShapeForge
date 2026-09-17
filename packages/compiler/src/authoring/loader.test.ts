// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  assertPartialProfileHasNoCrud,
  validateEntityContentIdentifiers,
  loadEntity,
  loadSemanticTypes,
  resolveEntityFilePath,
} from "./loader.js";
import type { CoreEntity } from "./types.js";
import type { EntityProfile } from "./types.js";

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
      { key: "id", osfType: "string" },
      { key: "displayName", osfType: "string" },
      { key: "ownerId", osfType: "User" },
    ],
  }) as CoreEntity;

describe("validateEntityContentIdentifiers", () => {
  it("accepts a conforming entity and field keys", () => {
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
    hostile.fields = [{ key: "id } evil: someOtherResolver { secret", osfType: "string" }];
    expect(() =>
      validateEntityContentIdentifiers(hostile, "hostile.yaml"),
    ).toThrow(/field key/);
  });

  it("rejects a field key containing a backtick (template-literal break-out)", () => {
    const hostile = baseEntity();
    hostile.fields = [{ key: "id`;evil()", osfType: "string" }];
    expect(() =>
      validateEntityContentIdentifiers(hostile, "hostile.yaml"),
    ).toThrow(/field key/);
  });

  it("rejects a hostile field key nested inside children", () => {
    const hostile = baseEntity();
    hostile.fields = [
      {
        key: "address",
        osfType: "object",
        children: [{ key: "street } x { y", osfType: "string" }],
      },
    ] as CoreEntity["fields"];
    expect(() =>
      validateEntityContentIdentifiers(hostile, "hostile.yaml"),
    ).toThrow(/field key/);
  });

  it("refuses an entity-level relationships block by name", () => {
    const legacy = baseEntity() as CoreEntity & { relationships?: unknown };
    legacy.relationships = [{ key: "owner", kind: "belongsTo", target: "User" }];
    expect(() =>
      validateEntityContentIdentifiers(legacy, "legacy.yaml"),
    ).toThrow(/Widget declares relationships \(owner\); relationships are fields/);
  });

  it("accepts a conforming rest basePath and the boolean/absent forms", () => {
    const withBasePath = baseEntity();
    withBasePath.rest = { basePath: "custom-widgets" };
    expect(() =>
      validateEntityContentIdentifiers(withBasePath, "test.yaml"),
    ).not.toThrow();

    const shorthand = baseEntity();
    shorthand.rest = true;
    expect(() =>
      validateEntityContentIdentifiers(shorthand, "test.yaml"),
    ).not.toThrow();
  });

  it("rejects a hostile rest basePath that would break out of a route/OpenAPI path", () => {
    for (const hostile of ["a/../b", "widgets/{id}", 'x" onload="evil', "Upper"]) {
      const entity = baseEntity();
      entity.rest = { basePath: hostile };
      expect(() =>
        validateEntityContentIdentifiers(entity, "hostile.yaml"),
      ).toThrow(/rest basePath/);
    }
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
  it("does not share mutable parsed YAML or keep stale source bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "entity-catalog-cache-"));
    try {
      mkdirSync(join(root, "catalogs"));
      const path = join(root, "catalogs/semantic-types.yaml");
      const write = (valueType: string) => writeFileSync(path, JSON.stringify({ types: { example: { label: { en: "Example" }, valueType } } }));
      write("string");
      const first = loadSemanticTypes(root);
      first.example!.label.en = "Changed by caller";
      expect(loadSemanticTypes(root).example!.label.en).toBe("Example");
      write("number");
      expect(loadSemanticTypes(root).example!.valueType).toBe("number");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("partial entity profile CRUD policy", () => {
  it("rejects CRUD declarations that a partial profile cannot own", () => {
    const profile = {
      schemaVersion: 1,
      kind: "entityProfile",
      entity: "Widget",
      fields: [],
      crud: false,
    } as unknown as EntityProfile;
    expect(() => assertPartialProfileHasNoCrud(profile, "partial/widget.yaml"))
      .toThrow(/partial entity profile/);
  });
});
