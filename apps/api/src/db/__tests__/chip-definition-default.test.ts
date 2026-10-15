// SPDX-License-Identifier: BUSL-1.1
import {expect, test} from "bun:test";
import {SQL} from "bun";
import {sql} from "kysely";
import {createDatabaseRuntime} from "../connection.js";
import migration from "../migrations/versioned/0016_chip-definition-default.js";
import {versionedMigrations} from "../migrations/versioned/index.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
test("Chip default migration preserves existing data and custom defaults", async () => {
  const name = `chip_default_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new SQL(adminUrl, {max: 1});
  const url = new URL(adminUrl); url.pathname = `/${name}`;
  await admin.unsafe(`create database "${name}"`);
  const runtime = createDatabaseRuntime({databaseUrl: url.toString(), maxConnections: 1});
  try {
    const db = runtime.db;
    await migration.up(db); // Hosts without this entity remain unchanged.
    await sql`create schema erp`.execute(db);
    await sql`create table erp.chips (id integer primary key, definition jsonb not null
      default '{"key":"value","osfType":"string","required":false}'::jsonb)`.execute(db);
    await sql`insert into erp.chips (id) values (1)`.execute(db);
    await migration.up(db);
    await migration.up(db); // Already upgraded is harmless.
    await sql`insert into erp.chips (id) values (2)`.execute(db);
    const rows = await sql<{id:number;definition:Record<string,unknown>}>`select * from erp.chips order by id`.execute(db);
    expect(rows.rows[0]?.definition).toEqual({key:"value",osfType:"string",required:false});
    expect(rows.rows[1]?.definition).toEqual({key:"value",osfType:"string",required:false,validation:{minLength:1,maxLength:8000}});
    await sql`alter table erp.chips alter column definition set default '{"key":"custom","osfType":"string"}'::jsonb`.execute(db);
    await migration.up(db);
    await sql`insert into erp.chips (id) values (3)`.execute(db);
    const custom = await sql<{definition:unknown}>`select definition from erp.chips where id=3`.execute(db);
    expect(custom.rows[0]?.definition).toEqual({key:"custom",osfType:"string"});
    expect(versionedMigrations.some(entry => entry.version === migration.version)).toBe(true);
  } finally {
    await runtime.close();
    await admin.unsafe(`drop database "${name}" with (force)`);
    await admin.close();
  }
}, 30000);
