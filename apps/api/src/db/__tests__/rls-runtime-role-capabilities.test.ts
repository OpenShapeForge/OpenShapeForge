// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE } from "../migrations/app-role.js";
import { WORKER_ROLE } from "../migrations/worker-role.js";
import { rlsBypassToken } from "../rls-bypass.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL;
(adminUrl ? test : test.skip)("ADMIN-only role management is not runtime access; effective direct, transitive and mixed access is", async () => {
  const prefix = `rls_caps_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const names = { manager: `${prefix}_mgr`, inherit: `${prefix}_inh`, set: `${prefix}_set`, viaSet: `${prefix}_via_set`, setBridge: `${prefix}_bridge_set`, transitive: `${prefix}_trans`, mixed: `${prefix}_mixed`, bridge: `${prefix}_bridge`, inherited: `${prefix}_bridge_inh` };
  const roles = Object.values(names);
  const password = crypto.randomUUID();
  const admin = new SQL(adminUrl!, { max: 1 });
  const dbUrl = new URL(adminUrl!); dbUrl.pathname = `/${prefix}`;
  const runtime = createDatabaseRuntime({ databaseUrl: dbUrl.href, maxConnections: 1 });
  const connect = (role: string) => { const url = new URL(dbUrl); url.username = role; url.password = password; return new SQL(url.href, { max: 1 }); };
  try {
    await admin.unsafe(`create database "${prefix}"`);
    await runtime.db.connection().execute(db => runMigrationChain(db));
    for (const role of roles) await admin.unsafe(`create role "${role}" login password '${password}' nosuperuser nobypassrls`);
    await admin.unsafe(`alter role "${names.manager}" createrole;
      grant "${APP_ROLE}", "${WORKER_ROLE}" to "${names.manager}" with admin true, inherit false, set false;
      grant "${APP_ROLE}" to "${names.inherit}" with inherit true, set false;
      grant "${WORKER_ROLE}" to "${names.set}" with inherit false, set true;
      grant "${WORKER_ROLE}" to "${names.setBridge}" with inherit false, set true;
      grant "${names.setBridge}" to "${names.viaSet}" with inherit false, set true;
      grant "${APP_ROLE}" to "${names.bridge}" with inherit true, set false;
      grant "${names.bridge}" to "${names.transitive}" with inherit true, set false;
      grant "${APP_ROLE}" to "${names.inherited}" with inherit true, set false;
      grant "${names.inherited}" to "${names.mixed}" with inherit false, set true;`);
    await sql.raw(`create table public.capability_rows(tenant integer not null);
      insert into public.capability_rows values(1),(2);
      alter table public.capability_rows owner to "${names.manager}";
      alter table public.capability_rows enable row level security;
      alter table public.capability_rows force row level security;
      create policy tenant on public.capability_rows using(app.bypass_rls() or tenant::text=current_setting('app.tenant_id',true));
      grant select on public.capability_rows to "${APP_ROLE}", "${WORKER_ROLE}";
      grant usage on schema app to ${roles.map(role => `"${role}"`).join(",")};
      grant execute on all functions in schema app to ${roles.map(role => `"${role}"`).join(",")};`).execute(runtime.db);
    const before: Array<{ roleid: number; member: number; grantor: number; admin_option: boolean; inherit_option: boolean; set_option: boolean }> = await admin`select roleid,member,grantor,admin_option,inherit_option,set_option from pg_auth_members where member=${names.manager}::regrole order by roleid`;
    expect(before).toHaveLength(2);
    expect(before.every(row => row.admin_option && !row.inherit_option && !row.set_option)).toBe(true);
    const manager = connect(names.manager);
    try {
      const [identity] = await manager`select current_user,session_user,app.session_is_runtime_login() as runtime,rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
      expect(identity).toEqual({ current_user: names.manager, session_user: names.manager, runtime: false, rolsuper: false, rolbypassrls: false });
      await manager`select set_config('app.tenant_id','1',false),set_config('app.bypass_rls','false',false)`;
      expect((await manager`select count(*)::int as n from public.capability_rows`)[0].n).toBe(1);
      await manager`select set_config('app.bypass_rls','true',false)`;
      expect((await manager`select count(*)::int as n from public.capability_rows`)[0].n).toBe(2);
    } finally { await manager.close(); }
    for (const [role, acting] of [[names.inherit, null], [names.set, WORKER_ROLE], [names.viaSet, WORKER_ROLE], [names.transitive, null], [names.mixed, names.inherited]] as const) {
      const login = connect(role);
      try {
        expect((await login`select app.session_is_runtime_login() as runtime`)[0].runtime).toBe(true);
        if (role === names.mixed) {
          expect((await login`select pg_has_role(session_user,${APP_ROLE},'USAGE') as usage,pg_has_role(session_user,${APP_ROLE},'SET') as can_set`)[0]).toEqual({ usage: false, can_set: false });
        }
        if (acting) await login.unsafe(`set role "${acting}"`);
        await login`select set_config('app.tenant_id','1',false),set_config('app.bypass_rls','true',false)`;
        await expect(login`select count(*)::int as n from public.capability_rows`).rejects.toThrow("is not accepted from a runtime database role");
        await login`select set_config('app.bypass_rls',${rlsBypassToken()},false)`;
        expect((await login`select count(*)::int as n from public.capability_rows`)[0].n).toBe(2);
      } finally { await login.close(); }
    }
    expect((await sql<{ runtime: boolean }>`select app.role_is_runtime_login(${APP_ROLE}::name) and app.role_is_runtime_login(${WORKER_ROLE}::name) and app.role_is_runtime_login(${prefix + "_absent"}::name) as runtime`.execute(runtime.db)).rows[0]?.runtime).toBe(true);
    const after: typeof before = await admin`select roleid,member,grantor,admin_option,inherit_option,set_option from pg_auth_members where member=${names.manager}::regrole order by roleid`;
    expect(after).toEqual(before);
  } finally {
    await runtime.close();
    await admin.unsafe(`drop database if exists "${prefix}" with(force)`);
    for (const role of roles) await admin.unsafe(`drop role if exists "${role}"`);
    await admin.close();
  }
}, 90_000);
