// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { databaseRole } from "../database-roles.js";

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const name = `identity_lookup_${suffix}`;
const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const admin = new SQL(adminUrl, { max: 1 });
const url = new URL(adminUrl);
url.pathname = `/${name}`;
const db = new SQL(url.toString(), { max: 1 });
const id = "00000000-0000-4000-8000-000000000001";
const resolverRole = databaseRole("identityResolver").name;

beforeAll(async () => {
  await admin.unsafe(`create role ${name} noinherit nosuperuser nobypassrls`);
  await admin.unsafe(`grant ${resolverRole} to ${name} with inherit true, set true`);
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
    grant usage on schema app, platform to ${resolverRole};
    grant select (id, keycloak_realm, keycloak_organization_id) on platform.tenants to ${resolverRole};
    grant select (id, subject) on platform.identities to ${resolverRole};
    create policy tenant_identity_resolution on platform.tenants for select to ${resolverRole} using (true);
    create policy identity_identity_resolution on platform.identities for select to ${resolverRole} using (true);
  `);
  // Exercise the shipped definitions, including SECURITY DEFINER and fixed
  // search_path, as a restricted managed-database migrator.
  const source = await Bun.file(new URL("../migrations/identity-link.ts", import.meta.url)).text();
  for (const fn of ["tenant_for_keycloak_organization", "identity_subject"]) {
    const start = source.indexOf(`create or replace function app.${fn}(`);
    const end = source.indexOf("$fn$;", start) + 5;
    if (start < 0 || end < start) throw new Error("Missing lookup definition");
    await db.unsafe(source.slice(start, end));
  }
  await db.unsafe(`
    grant create on schema app to ${resolverRole};
    alter function app.tenant_for_keycloak_organization(text, text) owner to ${resolverRole};
    alter function app.identity_subject(uuid) owner to ${resolverRole};
    revoke create on schema app from ${resolverRole};
  `);
  // The migrator needs SET membership only for the ownership transfer. The
  // runtime caller does not retain membership of the definer role.
  await admin.unsafe(`revoke ${resolverRole} from ${name}`);
});

afterAll(async () => {
  await db.close();
  await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.unsafe(`drop role if exists ${name}`);
  await admin.close();
});

for (const value of ["", "false"]) {
  test(`point lookups never raise the bypass setting from ${JSON.stringify(value)}`, async () => {
    await db.begin(async (tx) => {
      await tx`select set_config('app.bypass_rls', ${value}, true)`;
      expect((await tx`select app.tenant_for_keycloak_organization('test','org') as value`)[0].value).toBe(id);
      await tx`select set_config('app.user_id', 'subject', true)`;
      expect((await tx`select app.identity_subject(${id}::uuid) as value`)[0].value).toBe(true);
      await tx`select set_config('app.user_id', 'someone-else', true)`;
      expect((await tx`select app.identity_subject(${id}::uuid) as value`)[0].value).toBe(false);
      expect((await tx`select app.tenant_for_keycloak_organization('other','org') as value`)[0].value).toBeNull();
      expect((await tx`select app.identity_subject(null) as value`)[0].value).toBe(false);
      expect((await tx`select current_setting('app.bypass_rls',true) as value`)[0].value).toBe(value);
      expect((await tx`select count(*)::int as n from platform.identities`)[0].n).toBe(0);
      expect((await tx`select count(*)::int as n from platform.tenants`)[0].n).toBe(0);
    });
  });
}
