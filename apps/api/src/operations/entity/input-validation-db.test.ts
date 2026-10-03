// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { executeEntityOperation } from "./runtime.js";

// Scratch database on the compose Postgres (docs/testing.md, "Migration
// tests"); the shared development database is never touched.
const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const database = `write_contract_${randomUUID().replaceAll("-", "")}`;
const session = {
  tenantId: randomUUID(),
  userId: randomUUID(),
  roles: ["General.All.ReadWrite"],
  groups: [],
  scope: "tenant" as const,
};
let admin: SQL;
let privileged: DatabaseRuntime;
let runtime: DatabaseRuntime;

describe("entity write contract through executeEntityOperation", () => {
  beforeAll(async () => {
    const url = new URL(adminUrl);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/postgres") {
      throw new Error("Scratch tests require a local postgres admin database, never an application database.");
    }
    admin = new SQL(adminUrl, { max: 1 });
    await admin.unsafe(`create database "${database}"`);
    url.pathname = `/${database}`;
    privileged = createDatabaseRuntime({ databaseUrl: url.toString() });
    await privileged.db.connection().execute((connection) => runMigrationChain(connection));
    url.username = "openshapeforge_app";
    url.password = "openshapeforge_app";
    runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 4 });
  }, 90_000);

  afterAll(async () => {
    await runtime?.close();
    await privileged?.close();
    await admin?.unsafe(`drop database if exists "${database}" with (force)`);
    await admin?.close();
  });

  test("a REST-shaped create and update within the contract are stored; out-of-options values are refused", async () => {
    const created = await executeEntityOperation(runtime.db, session, {
      operation: { id: "Task.create", intent: "create" },
      input: { values: { title: "Call the tenant back", type: "follow_up", status: "open", estimatedMinutes: 15 } },
    });
    if (created.intent !== "create" || "error" in created || !created.data) throw new Error(`create failed: ${JSON.stringify(created)}`);
    const id = String(created.data.id);
    expect(created.data).toMatchObject({ status: "open", estimated_minutes: 15 });

    const refused = await executeEntityOperation(runtime.db, session, {
      operation: { id: "Task.update", intent: "update" },
      input: { id, values: { status: "banana", estimatedMinutes: 42.5 } },
    });
    expect(refused).toEqual({
      intent: "update",
      error: expect.objectContaining({
        code: "VALIDATION",
        violations: [
          expect.objectContaining({ field: "status", code: "NOT_IN_OPTIONS" }),
          expect.objectContaining({ field: "estimatedMinutes", code: "INVALID_TYPE" }),
        ],
      }),
    });

    const unchanged = await executeEntityOperation(runtime.db, session, {
      operation: { id: "Task.get", intent: "get" },
      input: { id },
    });
    if (unchanged.intent !== "get" || "error" in unchanged) throw new Error("get failed");
    expect(unchanged.data).toMatchObject({ status: "open", estimated_minutes: 15 });

    const updated = await executeEntityOperation(runtime.db, session, {
      operation: { id: "Task.update", intent: "update" },
      input: { id, values: { status: "completed", description: null } },
    });
    if (updated.intent !== "update" || "error" in updated) throw new Error(`update failed: ${JSON.stringify(updated)}`);
    expect(updated.data).toMatchObject({ status: "completed", estimated_minutes: 15, description: null });
  });
});
