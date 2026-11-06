// SPDX-License-Identifier: BUSL-1.1
/** Real API startup against separate PostgreSQL roles, never shared-role alterations. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { createApiApp, startApiRole } from "../../roles/api.js";
import { createDatabaseRuntime, type DatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { ensureScratchDatabaseRoles } from "./__fixtures__/scratch-roles.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const database = `runtime_role_${suffix}`;
const password = `startup-${suffix}`;
const roles = [
  { name: `startup_super_${suffix}`, attributes: "SUPERUSER NOBYPASSRLS", superuser: true, bypass: false },
  { name: `startup_bypass_${suffix}`, attributes: "NOSUPERUSER BYPASSRLS", superuser: false, bypass: true },
  { name: `startup_safe_${suffix}`, attributes: "NOSUPERUSER NOBYPASSRLS", superuser: false, bypass: false },
] as const;
const unsafeRoles = roles.slice(0, 2);
const safeRole = roles[2];
const TEST_TIMEOUT = 120_000;
let admin: SQL;
let migrator: DatabaseRuntime;

function databaseUrl(role?: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  if (role) {
    url.username = role;
    url.password = password;
  }
  return url.toString();
}

async function withEnvironment<T>(values: Record<string, string | undefined>, work: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const apply = (env: typeof values) => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(values);
  try {
    return await work();
  } finally {
    apply(saved);
  }
}

function startupEnvironment(role: string, nodeEnv = "production"): Record<string, string | undefined> {
  return {
    NODE_ENV: nodeEnv,
    HOST: "127.0.0.1",
    PORT: "0",
    DATABASE_URL: databaseUrl(role),
    OPENSHAPEFORGE_MIGRATE_DATABASE_URL: databaseUrl(),
    OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET: `startup-context-${suffix}-${randomUUID()}`,
    OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER: undefined,
    OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI: undefined,
    OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE: undefined,
    OPENSHAPEFORGE_GRAPHQL_CORS_MODE: "disabled",
  };
}

beforeAll(async () => {
  admin = new SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`create database ${database}`);
  migrator = createDatabaseRuntime({ databaseUrl: databaseUrl(), maxConnections: 1 });
  await withEnvironment({ NODE_ENV: "test" }, async () => {
    await ensureScratchDatabaseRoles(migrator.db);
    await migrator.db.connection().execute((db) => runMigrationChain(db));
  });
  for (const role of roles) {
    await admin.unsafe(`create role ${role.name} login password '${password}' ${role.attributes}`);
    await admin.unsafe(`grant openshapeforge_app to ${role.name}`);
    const probe = new SQL(databaseUrl(role.name), { max: 1 });
    try {
      const [actual] = await probe`
        select current_user as name, rolsuper, rolbypassrls
        from pg_catalog.pg_roles where rolname = current_user
      `;
      expect(actual).toEqual({ name: role.name, rolsuper: role.superuser, rolbypassrls: role.bypass });
    } finally {
      await probe.close();
    }
  }
}, TEST_TIMEOUT);

afterAll(async () => {
  await migrator?.close();
  await admin?.unsafe(`drop database if exists ${database} with (force)`);
  for (const role of roles) await admin?.unsafe(`drop role if exists ${role.name}`);
  await admin?.close();
});

describe("API runtime database role", () => {
  for (const role of unsafeRoles) {
    test(`production entry point refuses ${role.attributes}`, async () => {
      await withEnvironment(startupEnvironment(role.name), async () => {
        let app: Awaited<ReturnType<typeof startApiRole>> | undefined;
        try {
          await expect(startApiRole().then((started) => { app = started; })).rejects.toThrow(
            "API database role must be NOSUPERUSER and NOBYPASSRLS",
          );
        } finally {
          await app?.close();
        }
        // startApiRole owns its pool even when it cannot return the app. Allow
        // PostgreSQL to observe the socket close and retire its backend process.
        const deadline = Date.now() + 2_000;
        let connections: number;
        do {
          const [row] = await admin`
            select count(*)::int as connections from pg_stat_activity
            where datname = ${database} and usename = ${role.name}
          `;
          connections = row.connections;
          if (connections === 0) break;
          await Bun.sleep(20);
        } while (Date.now() < deadline);
        expect(connections).toBe(0);
      });
    }, TEST_TIMEOUT);

    test(`the app factory refuses ${role.attributes} before module init, also outside production`, async () => {
      await withEnvironment(startupEnvironment(role.name, "development"), async () => {
        let initialized = false;
        const app = createApiApp({
          cors: false,
          databaseUrl: databaseUrl(role.name),
          modules: {
            loaded: [{ name: "startup-probe", init: async () => { initialized = true; } }],
            failures: [],
          },
        });
        try {
          await expect(app.listen({ port: 0, host: "127.0.0.1" })).rejects.toThrow(
            "API database role must be NOSUPERUSER and NOBYPASSRLS",
          );
          expect(initialized).toBe(false);
          expect(app.server.listening).toBe(false);
        } finally {
          await app.close();
        }
      });
    }, TEST_TIMEOUT);
  }

  test("a restricted runtime role starts and serves with a separate privileged migration URL", async () => {
    await withEnvironment(startupEnvironment(safeRole.name), async () => {
      const app = await startApiRole();
      try {
        expect(app.server.listening).toBe(true);
        const address = app.server.address();
        if (!address || typeof address === "string") throw new Error("Expected a TCP listener.");
        const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
        expect(response.status).toBe(200);
        await response.text();
      } finally {
        await app.close();
      }
    });
  }, TEST_TIMEOUT);

  test("an unverifiable database connection prevents module init and serving", async () => {
    await withEnvironment(startupEnvironment(safeRole.name, "development"), async () => {
      const invalidUrl = new URL(databaseUrl(safeRole.name));
      invalidUrl.username = `missing_role_${suffix}`;
      let initialized = false;
      const app = createApiApp({
        cors: false,
        databaseUrl: invalidUrl.toString(),
        modules: {
          loaded: [{ name: "startup-probe", init: async () => { initialized = true; } }],
          failures: [],
        },
      });
      try {
        await expect(app.listen({ port: 0, host: "127.0.0.1" })).rejects.toThrow();
        expect(initialized).toBe(false);
        expect(app.server.listening).toBe(false);
      } finally {
        await app.close();
      }
    });
  }, TEST_TIMEOUT);
});
