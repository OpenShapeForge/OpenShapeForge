// SPDX-License-Identifier: BUSL-1.1
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createConnection, createServer, type Server } from "node:net";
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

if (!/^[a-z0-9_]+$/.test(databaseName) || new URL(ADMIN_URL).pathname === "/openshapeforge_dev") {
  throw new Error("Refusing an unsafe readiness outage scratch database target.");
}

afterAll(async () => {
  await app?.close().catch(() => undefined);
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

    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const reservedAddress = reservation.address();
    if (!reservedAddress || typeof reservedAddress === "string") {
      throw new Error("Failed to reserve a local database-proxy port.");
    }
    const proxyPort = reservedAddress.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const unavailableUrl = new URL(databaseUrl);
    unavailableUrl.hostname = "127.0.0.1";
    unavailableUrl.port = String(proxyPort);

    app = createApiApp({
      cors: false,
      databaseUrl: unavailableUrl.toString(),
      readinessCacheMs: 0,
      metricsRegistry: new Registry(),
      logStream: { write: (line) => logLines.push(line) },
    });
    await app.ready();
    const unavailable = await app.inject({ method: "GET", url: "/api/ready" });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().checks.database).toBe("not_ready");
    expect(unavailable.body).not.toContain(databaseName);
    const liveDuringOutage = await app.inject({ method: "GET", url: "/api/health" });
    expect(liveDuringOutage.statusCode).toBe(200);

    const adminAddress = new URL(ADMIN_URL);
    proxy = createServer((client) => {
      const upstream = createConnection({
        host: adminAddress.hostname,
        port: Number(adminAddress.port || 5432),
      });
      client.pipe(upstream);
      upstream.pipe(client);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      proxy!.once("error", reject);
      proxy!.listen(proxyPort, "127.0.0.1", resolve);
    });

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
