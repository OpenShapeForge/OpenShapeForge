// SPDX-License-Identifier: BUSL-1.1
/**
 * The `extension_values` source column of an extensible entity is
 * server-owned storage: callers read and write `extensions` and
 * `extensionsMeta`, never the column (contract fase 1a, "Record-I/O"). The
 * compiler binds it to the table as a jsonb column like any other, so every
 * surface that enumerates a table's columns must leave it out — for the
 * entity itself and for a subtype projection of the same physical table,
 * which reads the base table's columns but is not itself extensible.
 *
 * Database-free: the compiled acceptance entity of the test composition
 * (test/fixtures/authoring/extensible) and the generated artifacts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderTypeDefinition } from "../../../../graphql/generated-entity-schema.js";
import { fieldColumnMap } from "../../columns.js";
import { assertEntityValueInput } from "../../entity-value-io.js";
import { buildFilterConditions } from "../../queries.js";
import { serializeEntityRow } from "../../serialize-result.js";
import type { GeneratedCrudTable } from "../../types.js";
import { isCallerWritableColumn, normalizeWritableValues } from "../../write-policy.js";
import { EXTENSION_VALUES_COLUMN } from "../model.js";
import { carriesExtensionValues, extensibleEntityOf } from "../store.js";
import { acceptanceTable, ENTITY, READER_ROLE, sessionFor } from "./fixture.js";

const table = acceptanceTable();
/** A scoped projection of the same physical table, as the manifest's `entitySubtypes` binds one. */
const subtype: GeneratedCrudTable = {
  ...table,
  name: `${table.name}@${ENTITY}Kit`,
  source: { ...table.source!, authoringEntityName: `${ENTITY}Kit` },
  subtype: {
    base: { entityName: ENTITY, entityId: `core.${ENTITY}`, slug: "extensible-asset", table: table.name },
    scope: [], hiddenColumns: [],
  },
};
const source = table.columns.find((column) => column.name === EXTENSION_VALUES_COLUMN)!;
const raw = /extensionValues|extension_values/;

describe("the extension_values source column", () => {
  test("is bound to the compiled table, as the registry says", () => {
    expect(source).toMatchObject({ type: "jsonb" });
    expect(extensibleEntityOf(table)?.entity).toBe(ENTITY);
    expect(extensibleEntityOf(subtype)).toBeUndefined();
    expect(carriesExtensionValues(subtype)).toBe(true);
  });

  for (const [name, candidate] of [["the entity", table], ["a subtype projection", subtype]] as const) {
    describe(`on ${name}`, () => {
      test("is no caller field, filter or write", () => {
        expect([...fieldColumnMap(candidate).keys()]).not.toContain("extensionValues");
        for (const operation of ["create", "update"] as const) {
          expect(isCallerWritableColumn(candidate, source, operation)).toBe(false);
          // Refused before normalization, never silently dropped (the entity-value precedent).
          for (const key of ["extensionValues", EXTENSION_VALUES_COLUMN]) {
            expect(() => assertEntityValueInput(candidate, { [key]: {} }, operation)).toThrow("server-owned");
            expect(() => normalizeWritableValues(candidate, { name: "Object", [key]: {} }, operation)).toThrow("server-owned");
          }
        }
        const session = sessionFor(crypto.randomUUID(), [READER_ROLE]);
        for (const key of ["extensionValues", EXTENSION_VALUES_COLUMN]) {
          expect(() => buildFilterConditions(candidate, session, { [key]: { eq: "{}" } })).toThrow();
        }
      });

      test("is never serialized", () => {
        const row = { id: crypto.randomUUID(), name: "Object", [EXTENSION_VALUES_COLUMN]: { "6a0f7c2e-0000-4000-8000-000000000000": "secret" } };
        const serialized = serializeEntityRow(candidate, row);
        expect(Object.keys(serialized).some((key) => raw.test(key))).toBe(false);
        expect(JSON.stringify(serialized)).not.toContain("secret");
      });

      test("is no GraphQL field, input or filter", () => {
        expect(renderTypeDefinition(candidate)).not.toMatch(raw);
      });
    });
  }

  test("is absent from every generated interface contract", () => {
    const generated = (path: string) => readFileSync(new URL(`../../../../generated/${path}`, import.meta.url), "utf8");
    for (const path of ["rest/openapi.json", "mcp/tools.json", "graphql/documentation.json", "graphql/persisted-operations.json", "operations/catalog.json"]) {
      const contents = generated(path);
      expect(contents).toContain(ENTITY);
      expect(contents).not.toMatch(raw);
    }
  });
});
