// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const name = `identity_lookup_${suffix}`;
const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const admin = new SQL(adminUrl, { max: 1 });
const url = new URL(adminUrl);
url.pathname = `/${name}`;
const db = new SQL(url.toString(), { max: 1 });
const id = "00000000-0000-4000-8000-000000000001";

beforeAll(async () => {
  await admin.unsafe(`create role ${name} nosuperuser nobypassrls`);
  await admin.unsafe(`create database ${name} owner ${name}`);
  await db.unsafe(`set role ${name}`);
  await db.unsafe(`
    create schema app;
    create schema platform;
    create table platform.tenants(id uuid, keycloak_realm text, keycloak_organization_id text);
    create table platform.identities(id uuid, subject text);
    insert into platform.tenants values ('${id}', 'test', 'org');
    insert into platform.identities values ('${id}', 'subject');
    alter table platform.tenants enable row level security;
    alter table platform.tenants force row level security;
    alter table platform.identities enable row level security;
    alter table platform.identities force row level security;
    create policy tenant_guard on platform.tenants using (current_setting('app.bypass_rls',true)='true');
    create policy identity_guard on platform.identities using (current_setting('app.bypass_rls',true)='true');
  `);
  // Exercise the shipped definitions, including function attributes, as the
  // non-superuser owner rather than duplicating the implementation in a fixture.
  for (const [file, fn] of [
    ["app-helpers.ts", "tenant_for_keycloak_organization"],
    ["identity-link.ts", "identity_subject"],
  ]) {
    const source = await Bun.file(new URL(`../migrations/${file}`, import.meta.url)).text();
    const start = source.indexOf(`create or replace function app.${fn}(`);
    const end = source.indexOf("$$;", start) + 3;
    if (start < 0 || end < start) throw new Error("Missing lookup definition");
    await db.unsafe(source.slice(start, end));
  }
});

afterAll(async () => {
  await db.close();
  await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.unsafe(`drop role if exists ${name}`);
  await admin.close();
});

for (const value of ["", "false", "true"]) {
  test(`point lookups restore prior setting ${JSON.stringify(value)} inside the transaction`, async () => {
    await db.begin(async (tx) => {
      await tx`select set_config('app.bypass_rls', ${value}, true)`;
      expect((await tx`select app.tenant_for_keycloak_organization('test','org') as value`)[0].value).toBe(id);
      expect((await tx`select app.identity_subject(${id}::uuid) as value`)[0].value).toBe("subject");
      expect((await tx`select app.tenant_for_keycloak_organization('other','org') as value`)[0].value).toBeNull();
      expect((await tx`select app.identity_subject(null) as value`)[0].value).toBeNull();
      expect((await tx`select current_setting('app.bypass_rls',true) as value`)[0].value).toBe(value);
      expect((await tx`select count(*)::int as n from platform.identities`)[0].n).toBe(value === "true" ? 1 : 0);
      expect((await tx`select count(*)::int as n from platform.tenants`)[0].n).toBe(value === "true" ? 1 : 0);
    });
  });
}

for (const [table, call] of [
  ["tenants", "app.tenant_for_keycloak_organization('test','org')"],
  ["identities", `app.identity_subject('${id}'::uuid)`],
]) {
  test(`${table} lookup error cannot leave bypass enabled`, async () => {
    await db.begin(async (tx) => {
      await tx`select set_config('app.bypass_rls', 'false', true)`;
      await tx.unsafe(`alter table platform.${table} rename to hidden_lookup`);
      await tx.unsafe(`do $$ begin
        begin perform ${call}; raise exception 'expected undefined table';
        exception when undefined_table then null; end;
        if current_setting('app.bypass_rls',true) <> 'false' then
          raise exception 'bypass leaked';
        end if;
      end $$`);
      await tx.unsafe(`alter table platform.hidden_lookup rename to ${table}`);
      expect((await tx`select current_setting('app.bypass_rls',true) as value`)[0].value).toBe("false");
    });
  });
}
