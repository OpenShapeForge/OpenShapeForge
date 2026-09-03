// SPDX-License-Identifier: BUSL-1.1
/** Shared generated-CRUD output and oracle guards for elicited values. */
import { describe, expect, test } from "bun:test";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import {
  getGeneratedCrudTables,
  listGeneratedEntities,
  listGeneratedEntitiesForTable,
  projectGeneratedEntityRow,
} from "../generated-crud.js";
import { renderTypeDefinition } from "../generated-entity-schema.js";

const table = getGeneratedCrudTables().find(
  (candidate) => candidate.source?.authoringEntityName === "Preference",
)!;
const target = table.columns.find(
  (column) => column.sourceField === "valueJson",
)!;
const readRole = table.source!.authorization!.roles.read.find(
  (role) => !table.source!.authorization!.roles.update.includes(role),
)!;
const writeRole = table.source!.authorization!.roles.update[0]!;
const readSession = { tenantId: "tenant", userId: "reader", roles: [readRole] };
const writeSession = {
  tenantId: "tenant",
  userId: "writer",
  roles: [writeRole],
};
const noDb = null as unknown as OpenShapeForgeDatabase;
const storedSecret = {
  ciphertext: "opaque-storage-value",
  keyId: "test-key",
  algorithm: "aes-256-gcm",
};

async function withElicitedTarget(
  fn: () => Promise<void> | void,
  classification?: "confidential" | "pii" | "bsn",
) {
  const previousMcp = table.source!.mcp;
  const previousClassification = target.classification;
  table.source!.mcp = {
    toolPrefix: "preference",
    tools: "dedicated",
    operations: {
      list: true,
      get: true,
      create: true,
      update: true,
      delete: true,
    },
    elicitOnCreate: {
      sourceField: "key",
      sourceEntity: "Preference",
      definitionsField: "valueJson",
      into: "valueJson",
    },
  };
  if (classification) target.classification = classification;
  try {
    await fn();
  } finally {
    if (previousMcp) table.source!.mcp = previousMcp;
    else delete table.source!.mcp;
    if (previousClassification) target.classification = previousClassification;
    else delete target.classification;
  }
}

describe("elicited-value shared CRUD output", () => {
  test("preserves plain siblings and replaces only stored secrets for a writer", async () => {
    await withElicitedTarget(() => {
      const stored = {
        id: "row-1",
        value_json: {
          endpoint: "https://example.test",
          apiToken: storedSecret,
        },
      };
      const projected = projectGeneratedEntityRow(table, writeSession, stored);
      expect(projected).toEqual({
        id: "row-1",
        value_json: {
          endpoint: "https://example.test",
          apiToken: "__set__",
        },
      });
      expect(stored.value_json.apiToken).toBe(storedSecret);
    });
  });

  test("keeps absent targets absent and composes with classification", async () => {
    await withElicitedTarget(() => {
      expect(
        projectGeneratedEntityRow(table, writeSession, { id: "row-1" }),
      ).toEqual({
        id: "row-1",
      });
      expect(
        projectGeneratedEntityRow(table, readSession, {
          id: "row-2",
          value_json: { apiToken: storedSecret },
        }),
      ).toEqual({ id: "row-2", value_json: { apiToken: "__set__" } });
    });

    await withElicitedTarget(() => {
      const row = { id: "row-3", value_json: { apiToken: storedSecret } };
      expect(
        projectGeneratedEntityRow(table, readSession, row).value_json,
      ).toBeNull();
      expect(
        projectGeneratedEntityRow(table, writeSession, row).value_json,
      ).toEqual({
        apiToken: "__set__",
      });
    }, "confidential");
  });

  test("fails closed when compiled target metadata cannot resolve a column", async () => {
    await withElicitedTarget(() => {
      table.source!.mcp!.elicitOnCreate!.into = "missingField";
      expect(() =>
        projectGeneratedEntityRow(table, writeSession, {
          value_json: { apiToken: storedSecret },
        }),
      ).toThrow(/elicited-output metadata is invalid/);
      try {
        projectGeneratedEntityRow(table, writeSession, {
          value_json: { apiToken: storedSecret },
        });
      } catch (error) {
        expect((error as Error).message).not.toContain("missingField");
        expect((error as Error).message).not.toContain(storedSecret.ciphertext);
      }
    });
  });

  test("rejects filters and sorting before SQL for read and write callers", async () => {
    await withElicitedTarget(async () => {
      for (const session of [readSession, writeSession]) {
        for (const input of [
          { filter: { valueJson: { apiToken: storedSecret } } },
          { filter: { valueJsonIn: [{ apiToken: storedSecret }] } },
          { sort: { field: "valueJson", direction: "asc" } },
        ]) {
          const error = await listGeneratedEntities(noDb, session, {
            table: table.name,
            ...input,
          }).catch((caught: unknown) => caught);
          expect(error).toMatchObject({
            extensions: { code: "FORBIDDEN", status: 403 },
          });
          expect((error as Error).message).not.toContain(
            storedSecret.ciphertext,
          );
        }
      }
      await expect(
        listGeneratedEntitiesForTable(noDb, writeSession, table, {
          filter: { valueJson: { apiToken: storedSecret } },
        }),
      ).rejects.toMatchObject({
        extensions: { code: "FORBIDDEN", status: 403 },
      });
    });
  });

  test("withholds the target from the GraphQL filter input", async () => {
    await withElicitedTarget(() => {
      const sdl = renderTypeDefinition(table);
      const filter = sdl.split("input PreferenceFilter {")[1]!.split("}")[0]!;
      expect(filter).not.toContain("valueJson");
      expect(sdl).toContain("valueJson: JSON");
    });
  });
});
