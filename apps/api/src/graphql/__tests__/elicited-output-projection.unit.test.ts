// SPDX-License-Identifier: BUSL-1.1
/** Shared generated-CRUD output and oracle guards for elicited values. */
import { describe, expect, test } from "bun:test";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import {
  createGeneratedEntity,
  getGeneratedCrudTables,
  listGeneratedEntities,
  listGeneratedEntitiesForTable,
  projectGeneratedEntityRow,
  updateGeneratedEntity,
} from "../generated-crud.js";
import { renderTypeDefinition } from "../generated-entity-schema.js";

const table = getGeneratedCrudTables().find(
  (candidate) => candidate.source?.authoringEntityName === "Task",
)!;
const target = table.columns.find(
  (column) => column.sourceField === "metadata",
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
    toolPrefix: "task",
    tools: "dedicated",
    operations: {
      list: true,
      get: true,
      create: true,
      update: true,
      delete: true,
    },
    elicitOnCreate: {
      sourceField: "title",
      sourceEntity: "Task",
      definitionsField: "metadata",
      into: "metadata",
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
        metadata: {
          endpoint: "https://example.test",
          apiToken: storedSecret,
        },
      };
      const projected = projectGeneratedEntityRow(table, writeSession, stored);
      expect(projected).toEqual({
        id: "row-1",
        metadata: {
          endpoint: "https://example.test",
          apiToken: "__set__",
        },
      });
      expect(stored.metadata.apiToken).toBe(storedSecret);
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
          metadata: { apiToken: storedSecret },
        }),
      ).toEqual({ id: "row-2", metadata: { apiToken: "__set__" } });
    });

    await withElicitedTarget(() => {
      const row = { id: "row-3", metadata: { apiToken: storedSecret } };
      expect(
        projectGeneratedEntityRow(table, readSession, row).metadata,
      ).toBeNull();
      expect(
        projectGeneratedEntityRow(table, writeSession, row).metadata,
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
          metadata: { apiToken: storedSecret },
        }),
      ).toThrow(/elicited-output metadata is invalid/);
      try {
        projectGeneratedEntityRow(table, writeSession, {
          metadata: { apiToken: storedSecret },
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
          { filter: { metadata: { apiToken: storedSecret } } },
          { filter: { metadataIn: [{ apiToken: storedSecret }] } },
          { sort: { field: "metadata", direction: "asc" } },
        ]) {
          const error = await listGeneratedEntities(noDb, session, {
            table: table.name,
            ...input,
          }).catch((caught: unknown) => caught);
          expect(error).toMatchObject({
            operationError: { code: "FORBIDDEN", retryable: false },
          });
          expect((error as Error).message).not.toContain(
            storedSecret.ciphertext,
          );
        }
      }
      await expect(
        listGeneratedEntitiesForTable(noDb, writeSession, table, {
          filter: { metadata: { apiToken: storedSecret } },
        }),
      ).rejects.toMatchObject({
        operationError: { code: "FORBIDDEN", retryable: false },
      });
    });
  });

  test("rejects caller-supplied elicited targets before SQL", async () => {
    await withElicitedTarget(async () => {
      for (const supplied of [
        "plaintext-secret",
        { ciphertext: "malformed" },
        storedSecret,
        null,
      ]) {
        const createError = await createGeneratedEntity(noDb, writeSession, {
          table: table.name,
          values: { metadata: supplied },
        }).catch((caught: unknown) => caught);
        expect(createError).toMatchObject({
          operationError: { code: "BAD_USER_INPUT", retryable: false },
        });
        expect((createError as Error).message).not.toContain(
          JSON.stringify(supplied),
        );

        const updateError = await updateGeneratedEntity(noDb, writeSession, {
          table: table.name,
          id: "row-1",
          values: { metadata: supplied },
        }).catch((caught: unknown) => caught);
        expect(updateError).toMatchObject({
          operationError: { code: "BAD_USER_INPUT", retryable: false },
        });
        expect((updateError as Error).message).not.toContain(
          JSON.stringify(supplied),
        );
      }
    });
  });

  test("withholds the target from GraphQL filters and mutation inputs", async () => {
    await withElicitedTarget(() => {
      const sdl = renderTypeDefinition(table);
      const filter = sdl.split("input TaskFilter {")[1]!.split("}")[0]!;
      expect(filter).not.toContain("metadata");
      const create = sdl
        .split("input CreateTaskInput {")[1]!
        .split("}")[0]!;
      const update = sdl
        .split("input UpdateTaskInput {")[1]!
        .split("}")[0]!;
      expect(create).not.toContain("metadata");
      expect(update).not.toContain("metadata");
      expect(sdl).toContain("metadata: JSON");
    });
  });
});
