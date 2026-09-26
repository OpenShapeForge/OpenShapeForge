// SPDX-License-Identifier: BUSL-1.1
/**
 * The acting Relation reaches the database as `app.current_relation_id()`,
 * and a nested database call can never borrow or drop the outer session's
 * Relation: a person-owned row is only ever read or written as the Relation
 * the caller itself carries.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../connection.js";
import { applyAppHelpersMigration } from "../migrations/app-helpers.js";
import { type DbSessionInput, withDbSession } from "../session.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const scratchName = `acting_relation_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const tenantId = randomUUID();
const userId = randomUUID();
const relationId = randomUUID();

const linked: DbSessionInput = {
  tenantId,
  userId,
  relation: { status: "linked", relationId },
};
const unlinked: DbSessionInput = { tenantId, userId };

let admin: SQL;
let runtime: DatabaseRuntime;

function scratchUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${scratchName}`;
  return url.toString();
}

async function currentRelation(session: DbSessionInput): Promise<string | null> {
  return withDbSession(runtime.db, session, async (trx) =>
    (await sql<{ id: string | null }>`select app.current_relation_id()::text as id`.execute(trx)).rows[0]?.id ?? null);
}

beforeAll(async () => {
  admin = new SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`create database "${scratchName}"`);
  runtime = createDatabaseRuntime({ databaseUrl: scratchUrl(), maxConnections: 2 });
  await applyAppHelpersMigration(runtime.db);
}, 60_000);

afterAll(async () => {
  await runtime?.close();
  await admin?.unsafe(`drop database if exists "${scratchName}" with (force)`);
  await admin?.close();
});

describe("acting Relation session", () => {
  test("a linked session carries its Relation; an unlinked or pending one carries none", async () => {
    expect(await currentRelation(linked)).toBe(relationId);
    expect(await currentRelation(unlinked)).toBeNull();
    expect(await currentRelation({ tenantId, userId, relation: { status: "pending_confirmation", relationId } })).toBeNull();
    expect(await currentRelation({ tenantId, userId, relationId })).toBe(relationId);
  });

  test("nested work cannot drop or borrow the outer session's Relation", async () => {
    await expect(withDbSession(runtime.db, linked, () => currentRelation(unlinked)))
      .rejects.toThrow("Nested database work cannot replace the active session.");
    await expect(withDbSession(runtime.db, unlinked, () => currentRelation(linked)))
      .rejects.toThrow("Nested database work cannot replace the active session.");
    expect(await withDbSession(runtime.db, linked, () => currentRelation({ ...linked }))).toBe(relationId);
  });
});
