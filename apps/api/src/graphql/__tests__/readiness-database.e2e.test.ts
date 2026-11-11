// SPDX-License-Identifier: BUSL-1.1
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { SQL } from "bun";
import { Registry } from "@openshapeforge/observability";
import { createDatabaseRuntime } from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { GENERATED_SCHEMA_MIGRATION_VERSION } from "../../db/schema-drift.js";
import { createApiApp } from "../../roles/api.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const databaseName = `readiness_outage_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const databaseUrl = new URL(ADMIN_URL);
databaseUrl.pathname = `/${databaseName}`;
const admin = new SQL(ADMIN_URL, { max: 1 });
let app: ReturnType<typeof createApiApp> | null = null;
let proxy: Server | null = null;
let control: SQL | null = null;
const logLines: string[] = [];
const sockets = new Set<Socket>();
let available = true;

if (!/^[a-z0-9_]+$/.test(databaseName) || new URL(ADMIN_URL).pathname === "/openshapeforge_dev") {
  throw new Error("Refusing an unsafe readiness outage scratch database target.");
}

afterAll(async () => {
  await app?.close().catch(() => undefined);
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => proxy?.close(() => resolve()) ?? resolve());
  await control?.close();
  await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
  await admin.close();
});

describe("live dependency-aware readiness", () => {
  test("recovers after a real database outage without restarting the API", async () => {
    await admin.unsafe(`create database "${databaseName}"`);
    const migrator = createDatabaseRuntime({ databaseUrl: databaseUrl.toString() });
    try {
      await migrator.db.connection().execute((connection) => runMigrationChain(connection));
    } finally {
      await migrator.close();
    }

    const adminAddress = new URL(ADMIN_URL);
    proxy = createServer((client) => {
      if (!available) { client.destroy(); return; }
      const upstream = createConnection({
        host: adminAddress.hostname,
        port: Number(adminAddress.port || 5432),
      });
      for (const socket of [client, upstream]) {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      }
      client.pipe(upstream);
      upstream.pipe(client);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      proxy!.once("error", reject);
      proxy!.listen(0, "127.0.0.1", resolve);
    });
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Database proxy did not bind.");
    const runtimeUrl = new URL(process.env.DATABASE_URL ??
      "postgres://openshapeforge_app:openshapeforge_app@localhost:5434/openshapeforge_dev");
    runtimeUrl.pathname = `/${databaseName}`;
    runtimeUrl.hostname = "127.0.0.1";
    runtimeUrl.port = String(address.port);
    app = createApiApp({
      cors: false,
      databaseUrl: runtimeUrl.toString(),
      readinessCacheMs: 0,
      metricsRegistry: new Registry(),
      logStream: { write: (line) => logLines.push(line) },
    });
    // Startup validates the restricted role and schema while the database is reachable.
    await app.ready();
    expect((await app.inject({ method: "GET", url: "/api/ready" })).statusCode).toBe(200);
    available = false;
    for (const socket of sockets) socket.destroy();
    const unavailable = await app.inject({ method: "GET", url: "/api/ready" });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().checks.database).toBe("not_ready");
    expect(unavailable.body).not.toContain(databaseName);
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    available = true;

    let recovered = await app.inject({ method: "GET", url: "/api/ready" });
    for (let attempt = 0; recovered.statusCode !== 200 && attempt < 20; attempt += 1) {
      await Bun.sleep(100);
      recovered = await app.inject({ method: "GET", url: "/api/ready" });
    }
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().status).toBe("ready");
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);

    control = new SQL(databaseUrl.toString(), { max: 1 });
    const checksumRows = await control`
      select checksum from platform.schema_migrations
      where version = ${GENERATED_SCHEMA_MIGRATION_VERSION}
    ` as unknown as { checksum: string }[];
    const generatedChecksum = checksumRows[0]?.checksum;
    if (!generatedChecksum) throw new Error("Generated migration checksum was not recorded.");

    logLines.length = 0;
    await control`
      update platform.schema_migrations set checksum = ${"stale-readiness-proof"}
      where version = ${GENERATED_SCHEMA_MIGRATION_VERSION}
    `;
    const behind = await app.inject({ method: "GET", url: "/api/ready" });
    expect(behind.statusCode).toBe(503);
    expect(behind.body).not.toContain("GENERATED_SCHEMA_BEHIND");
    expect(logLines.join("")).toContain('"errorCode":"GENERATED_SCHEMA_BEHIND"');
    await control`
      update platform.schema_migrations set checksum = ${generatedChecksum}
      where version = ${GENERATED_SCHEMA_MIGRATION_VERSION}
    `;

    logLines.length = 0;
    await control`
      insert into platform.schema_migrations (version, checksum, applied_by)
      values (${"9999_readiness_future"}, ${"future-proof"}, ${"readiness-test"})
    `;
    const ahead = await app.inject({ method: "GET", url: "/api/ready" });
    expect(ahead.statusCode).toBe(200);
    expect(ahead.body).not.toContain("VERSIONED_LEDGER_AHEAD");
    expect(logLines.join("")).not.toContain(databaseName);
    await control`
      delete from platform.schema_migrations where version = ${"9999_readiness_future"}
    `;
  }, 90_000);
});
