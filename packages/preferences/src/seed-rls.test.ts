import { expect, test } from "bun:test";
import { SQL } from "bun";
import { fileURLToPath } from "node:url";
import type { ModuleSeed, ModuleSeedContext } from "@openshapeforge/plugin-runtime";
import { catalogMigration } from "./index.js";
import { preferenceDefinitionsSeed } from "./seed.js";

// Dedicated EMPTY disposable database only: CREATE SCHEMA deliberately refuses
// to reuse an existing application schema. No production credentials or cleanup.
const url = process.env.OSF_PREFERENCES_RLS_TEST_DATABASE_URL;
test.skipIf(!url)("managed seed writes under FORCE RLS without leaking context after commit or rollback", async () => {
  const sql = new SQL(url!, { max: 1 });
  const execute = async (statement: string) => await sql.unsafe(statement);
  try {
    await sql.unsafe("create role preference_seed_test nosuperuser nobypassrls nologin");
    await sql.unsafe("create schema platform authorization preference_seed_test; create schema app");
    await sql.unsafe("create function app.bypass_rls() returns boolean language sql stable as $$ select coalesce(current_setting('app.bypass_rls', true) = 'true', false) $$; grant usage on schema app to preference_seed_test");
    await sql.unsafe("set role preference_seed_test");
    await sql.unsafe(catalogMigration);
    const roles = await sql.unsafe("select rolsuper, rolbypassrls from pg_roles where rolname = current_user");
    expect(roles[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
    await expect(execute("insert into platform.preference_definitions values ('test', 'forbidden', '{}')")).rejects.toThrow();
    const context: ModuleSeedContext = { seedDirectory: fileURLToPath(new URL("./__fixtures__/", import.meta.url)),
      schemas: { fields: { object: () => ({}), validateObject: () => ({ valid: true }) }, json: { validate: () => ({ valid: true }) } } };
    const database = (fail: boolean) => ({ transaction: () => ({ execute: (work: (db: unknown) => Promise<unknown>) => sql.begin(async tx => work({
      executeQuery: async (q: { sql: string; parameters: readonly unknown[] }) => {
        const rows = await tx.unsafe(q.sql, [...q.parameters] as never[]);
        if (fail && q.sql.startsWith("delete")) throw new Error("simulated seed failure");
        return { rows };
      },
    })) }) }) as unknown as Parameters<ModuleSeed["apply"]>[0];
    expect(await preferenceDefinitionsSeed.apply(database(false), context)).toMatchObject({ rows: 1 });
    expect((await sql.unsafe("select app.bypass_rls() as active"))[0].active).toBe(false);
    await expect(execute("delete from platform.preference_definitions")).resolves.toMatchObject({ count: 0 });
    await expect(preferenceDefinitionsSeed.apply(database(true), context)).rejects.toThrow("simulated seed failure");
    expect((await sql.unsafe("select app.bypass_rls() as active"))[0].active).toBe(false);
    expect((await sql.unsafe("select count(*)::int as count from platform.preference_definitions"))[0].count).toBe(1);
    await expect(execute("insert into platform.preference_definitions values ('test', 'forbidden', '{}')")).rejects.toThrow();
  } finally { await sql.close(); }
});
