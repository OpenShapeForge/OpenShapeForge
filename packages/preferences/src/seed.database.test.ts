// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { SQL } from "bun";
import { catalogMigration } from "./index.js";
import { preferenceDefinitionsSeed } from "./seed.js";
import type { ModuleSeedContext } from "@openshapeforge/plugin-runtime";

test.skipIf(process.env.PREFERENCES_SEED_DATABASE_TEST !== "1")("managed seed works without superuser and releases its RLS context on success and failure", async () => {
  const name = `preferences_seed_${randomUUID().replaceAll("-", "")}`;
  const role = `${name}_owner`;
  const admin = new SQL("postgres://openshapeforge:openshapeforge@127.0.0.1:5435/postgres", { max: 1 });
  const api = fileURLToPath(new URL("../../../apps/api/", import.meta.url));
  const { createDatabaseRuntime } = await import(`${api}src/db/connection.ts`);
  const { sql } = await import(Bun.resolveSync("kysely", api));
  let runtime: any;
  await admin.unsafe(`create database "${name}"`);
  try {
    await admin.unsafe(`create role "${role}" nologin nosuperuser nocreatedb nocreaterole nobypassrls`);
    runtime = createDatabaseRuntime({ databaseUrl: `postgres://openshapeforge:openshapeforge@127.0.0.1:5435/${name}`, maxConnections: 1 });
    await runtime.db.connection().execute(async (db: any) => {
      await sql.raw(`create schema app; create schema platform;
        create function app.bypass_rls() returns boolean language sql stable as $$
          select coalesce(current_setting('app.bypass_rls',true)='true',false) $$;
        ${catalogMigration}
        alter table platform.preference_definitions owner to "${role}";
        grant usage on schema app,platform to "${role}";`).execute(db);
      await sql.raw(`set role "${role}"`).execute(db);
      const context: ModuleSeedContext = {
        schemas: { fields: { object: () => ({}), validateObject: () => ({ valid: true }) }, json: { validate: () => ({ valid: true }) } },
        seedDirectory: fileURLToPath(new URL("./__fixtures__/", import.meta.url)),
      };
      try {
        const roles = await sql`select rolsuper,rolbypassrls from pg_roles where rolname=current_user`.execute(db);
        expect(roles.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
        await expect(sql`insert into platform.preference_definitions values('manual','denied','{}')`.execute(db)).rejects.toThrow();
        await preferenceDefinitionsSeed.apply(db, context);
        expect((await sql`select count(*)::int n from platform.preference_definitions`.execute(db)).rows[0].n).toBe(1);
        expect((await sql`select app.bypass_rls() enabled`.execute(db)).rows[0].enabled).toBe(false);
        await expect(sql`insert into platform.preference_definitions values('manual','denied','{}')`.execute(db)).rejects.toThrow();
        await sql`alter table platform.preference_definitions add constraint reject_seed check(key <> 'columns') not valid`.execute(db);
        await expect(preferenceDefinitionsSeed.apply(db, context)).rejects.toThrow();
        expect((await sql`select app.bypass_rls() enabled`.execute(db)).rows[0].enabled).toBe(false);
        expect((await sql`select count(*)::int n from platform.preference_definitions`.execute(db)).rows[0].n).toBe(1);
      } finally { await sql.raw("reset role").execute(db); }
    });
  } finally {
    await runtime?.close();
    await admin.unsafe(`drop database "${name}"`);
    await admin.unsafe(`drop role if exists "${role}"`);
    await admin.close();
  }
}, 30_000);
