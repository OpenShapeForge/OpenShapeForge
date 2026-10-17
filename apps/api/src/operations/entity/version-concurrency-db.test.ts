// SPDX-License-Identifier: BUSL-1.1
/**
 * Optimistic version concurrency on the two relation parties, against a real
 * database and through `executeEntityOperation` only — the same generic entity
 * path REST, MCP and Web use.
 *
 * NaturalPerson and LegalEntity are written by imports and background work as
 * well as by people, and neither requires an edit lease: the record version is
 * the whole guard. So what is proven here is that guard, on both entities: a
 * write without the version is refused, a write carrying the version the
 * record no longer has is refused, and the version the record does have is
 * accepted. The refusal is deliberately conservative about what "stale" means:
 * it is the record version that is checked, not the fields written, so a stale
 * writer is refused even when the properties it sets are disjoint from the one
 * that changed under it. Such a writer decided what to write from a record it
 * has since lost, and the guard makes it read again rather than judging for it
 * which of those decisions survived.
 *
 * Scratch database on the task's own Postgres (docs/testing.md, "Migration
 * tests"); the shared development database is never touched.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { APP_ROLE, DEV_APP_ROLE_PASSWORD_DEFAULT } from "../../db/migrations/app-role.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { executeEntityOperation, getEntityOperationContracts } from "./runtime.js";
import type { EntityOperationInput, EntityOperationResult, GeneratedEntityRow } from "./types.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const database = `version_concurrency_${randomUUID().replaceAll("-", "")}`;
const editor = {
  tenantId: randomUUID(),
  userId: randomUUID(),
  roles: ["Relations.All.ReadWrite"],
  groups: [],
  scope: "tenant" as const,
};

let admin: SQL;
let privileged: DatabaseRuntime;
let runtime: DatabaseRuntime;

type Session = typeof editor;

const intentOf = (id: string) => id.split(".")[1] as "list" | "get" | "create" | "update" | "delete";

function run(session: Session, id: string, input: EntityOperationInput): Promise<EntityOperationResult> {
  return executeEntityOperation(runtime.db, session, {
    operation: { id, intent: intentOf(id) },
    input,
  });
}

/** The record of a successful result, or a failure that names what went wrong. */
function record(result: EntityOperationResult): GeneratedEntityRow {
  if ("error" in result) throw new Error(`${result.intent} failed: ${JSON.stringify(result.error)}`);
  if (result.intent === "list" || result.intent === "delete" || !result.data) {
    throw new Error(`${result.intent} returned no record.`);
  }
  return result.data;
}

const failure = (result: EntityOperationResult) =>
  "error" in result ? result.error : undefined;

/** The concurrency token the update requires, as the record currently stands. */
async function version(table: string, id: string): Promise<string> {
  const rows = await sql<{ version: string }>`
    select updated_at::text as version from ${sql.id("erp", table)} where id = ${id}::uuid
  `.execute(privileged.db);
  return String(rows.rows[0]!.version);
}

async function stored(table: string, id: string): Promise<Record<string, unknown>> {
  const rows = await sql<{ row: Record<string, unknown> }>`
    select to_jsonb(t.*) as row from ${sql.id("erp", table)} t where id = ${id}::uuid
  `.execute(privileged.db);
  return rows.rows[0]!.row;
}

/**
 * The aggregate both parties hang off. Inserted with the privileged role
 * because Relation.relationType is reference data a scratch database has no
 * reason to carry; nothing under test reads it.
 */
async function relation(): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into erp.relations (id, tenant_id, display_name, relation_type, status)
    values (${id}::uuid, ${editor.tenantId}::uuid, 'Version target', 'person', 'active')
  `.execute(privileged.db);
  return id;
}

async function person(): Promise<string> {
  const created = record(await run(editor, "NaturalPerson.create", {
    values: { firstName: "Imported", lastName: "Party", relationId: await relation() },
  }));
  return String(created.id);
}

async function company(): Promise<string> {
  const created = record(await run(editor, "LegalEntity.create", {
    values: { name: "Imported Party B.V.", relationId: await relation() },
  }));
  return String(created.id);
}

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
  url.username = APP_ROLE;
  url.password = process.env.OPENSHAPEFORGE_APP_PASSWORD ?? DEV_APP_ROLE_PASSWORD_DEFAULT;
  runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 4 });
}, 180_000);

afterAll(async () => {
  await runtime?.close();
  await privileged?.close();
  await admin?.unsafe(`drop database if exists "${database}" with (force)`);
  await admin?.close();
});

describe("relation parties require the record version they read", () => {
  test("both updates declare required updatedAt version concurrency and no lease", () => {
    for (const id of ["NaturalPerson.update", "LegalEntity.update"]) {
      const contract = getEntityOperationContracts().find((operation) => operation.id === id);
      expect(contract?.concurrency?.version).toEqual({ mode: "required", field: "updatedAt" });
      expect(contract?.concurrency?.editLease).toBeUndefined();
    }
  });

  test("a NaturalPerson write without the version is refused, with it is stored, and a stale one is refused", async () => {
    const id = await person();
    const first = await version("natural_persons", id);

    expect(failure(await run(editor, "NaturalPerson.update", {
      id, values: { firstName: "Versionless" },
    }))).toMatchObject({ code: "BAD_USER_INPUT" });
    expect(await stored("natural_persons", id)).toMatchObject({ first_name: "Imported" });

    expect(record(await run(editor, "NaturalPerson.update", {
      id, expectedVersion: first, values: { firstName: "Corrected" },
    }))).toMatchObject({ first_name: "Corrected" });
    const second = await version("natural_persons", id);
    expect(second).not.toBe(first);

    expect(failure(await run(editor, "NaturalPerson.update", {
      id, expectedVersion: first, values: { firstName: "Stale" },
    }))).toMatchObject({ code: "VERSION_CONFLICT" });
    expect(await stored("natural_persons", id)).toMatchObject({ first_name: "Corrected" });
    expect(await version("natural_persons", id)).toBe(second);
  });

  test("a stale NaturalPerson write is refused even when it sets only a disjoint field", async () => {
    const id = await person();
    // What a background import or workflow read before it started composing
    // its write.
    const read = await version("natural_persons", id);

    // Meanwhile a person corrects a different field, through the same path.
    expect(record(await run(editor, "NaturalPerson.update", {
      id, expectedVersion: read, values: { lastName: "Corrected-By-User" },
    }))).toMatchObject({ last_name: "Corrected-By-User" });

    // The stale writer sets only firstName, which the user's change never
    // touched. A partial update would leave lastName alone, so nothing is
    // overwritten here — it is refused because the snapshot it decided from is
    // gone, not because the two writes collide on a column.
    expect(failure(await run(editor, "NaturalPerson.update", {
      id, expectedVersion: read, values: { firstName: "From-Import" },
    }))).toMatchObject({ code: "VERSION_CONFLICT" });
    expect(await stored("natural_persons", id))
      .toMatchObject({ first_name: "Imported", last_name: "Corrected-By-User" });
  });

  test("a LegalEntity write without the version is refused, with it is stored, and a stale one is refused", async () => {
    const id = await company();
    const first = await version("legal_entities", id);

    expect(failure(await run(editor, "LegalEntity.update", {
      id, values: { name: "Versionless B.V." },
    }))).toMatchObject({ code: "BAD_USER_INPUT" });

    expect(record(await run(editor, "LegalEntity.update", {
      id, expectedVersion: first, values: { name: "Corrected B.V." },
    }))).toMatchObject({ name: "Corrected B.V." });
    const second = await version("legal_entities", id);

    // And the same disjoint-field refusal the person case shows: the stale
    // writer sets only registrationNumber, untouched by the change above, and
    // is refused on the record version alone.
    expect(failure(await run(editor, "LegalEntity.update", {
      id, expectedVersion: first, values: { registrationNumber: "12345678" },
    }))).toMatchObject({ code: "VERSION_CONFLICT" });
    expect(await stored("legal_entities", id))
      .toMatchObject({ name: "Corrected B.V.", registration_number: null });
    expect(await version("legal_entities", id)).toBe(second);
  });
});
