// SPDX-License-Identifier: BUSL-1.1
/**
 * The chain that was missing: HTTP → surface → authorization → installation →
 * secrets → governor → package → validated result.
 *
 * Every other suite covers one link. This one covers the joins, because the
 * joins are where this session's real bugs lived: an error masked between
 * layers, a check ordered wrongly, a value that changed shape crossing a
 * boundary. It drives a booted API and a real connector package, with a stubbed
 * upstream so the assertions are about our behaviour rather than the network's.
 *
 * Needs the compose Postgres up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes, randomUUID, sign as signEd25519 } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { getProcessPrometheusRegistry } from "@openshapeforge/observability";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { listConnectorContracts } from "../catalog.js";
import { CONNECTOR_ADMIN_ROLE } from "../authorization.js";
import { keyringFromEnv } from "../secrets.js";
import { loadConnectorPackages } from "../loader.js";
import { ConnectorGovernor } from "../reliability.js";
import { configureConnector, setConnectorEnabled } from "../service.js";
import type { ConnectorExecutionError } from "../executor.js";
import { invokeConnectorOperation, verifyConnectorInstallation } from "../runtime.js";
import { rotateSecrets } from "../store.js";
import { CONNECTOR_AGGREGATE } from "../audit.js";
import type { ModuleEgressRequest } from "../../modules/contract.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE = "openshapeforge_app";

const SLUG = "example-object-store";
const ENTITLEMENT = "connector.example-object-store";
const TENANT = randomUUID();
const OTHER_TENANT = randomUUID();
const USER = randomUUID();

// A real signed deployment license: the entitlement gate is binding at
// configuration time, so a fixture without one is refused — as it should be.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const LICENSE_PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" }).toString();
const LICENSE_TOKEN = (() => {
  const payload = Buffer.from(JSON.stringify({ entitlements: [ENTITLEMENT] }), "utf8");
  return `${payload.toString("base64url")}.${signEd25519(null, payload, privateKey).toString("base64url")}`;
})();

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");
const keyring = keyringFromEnv(`k1:${KEY_A}`)!;
const rotatedKeyring = keyringFromEnv(`k2:${KEY_B},k1:${KEY_A}`)!;

let scratchName: string;
let admin: SQL;
let runtime: DatabaseRuntime;
let registry: Awaited<ReturnType<typeof loadConnectorPackages>>;
const governor = new ConnectorGovernor();

function contract() {
  const found = listConnectorContracts().find((entry) => entry.slug === SLUG);
  if (!found) throw new Error("example contract missing");
  return found;
}

function operation(key: string) {
  const found = contract().operations.find((entry) => entry.key === key);
  if (!found) throw new Error(`operation ${key} missing`);
  return found;
}

function session(tenantId = TENANT, roles: string[] = []) {
  return { tenantId, userId: USER, roles, groups: [], scope: "tenant" as const };
}

function catalogContext(tenantId = TENANT, roles: string[] = []) {
  return {
    db: runtime.db,
    session: session(tenantId, roles),
    config: {
      licensePublicKey: LICENSE_PUBLIC_KEY,
      licenseToken: LICENSE_TOKEN,
      keyring,
      installedPackages: new Set([SLUG]),
    },
    now: Date.now(),
    contracts: listConnectorContracts(),
  };
}

function invocationContext(tenantId = TENANT, roles: string[] = []) {
  return {
    db: runtime.db,
    session: session(tenantId, roles),
    registry,
    governor,
    keyring,
    roles,
  };
}

beforeAll(async () => {
  scratchName = `connector_dispatch_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  admin = new SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`create database "${scratchName}"`);

  const adminUrl = new URL(ADMIN_URL);
  adminUrl.pathname = `/${scratchName}`;
  const privileged = createDatabaseRuntime({
    databaseUrl: adminUrl.toString(),
    maxConnections: 1,
  });
  await privileged.db.connection().execute((conn) => runMigrationChain(conn));
  for (const tenant of [TENANT, OTHER_TENANT]) {
    await sql`
      insert into platform.connector_entitlements (tenant_id, entitlement)
      values (${tenant}::uuid, ${ENTITLEMENT})
    `.execute(privileged.db);
  }
  await privileged.close();

  // Connect as the RESTRICTED role: a superuser bypasses RLS, which would make
  // every tenant-isolation assertion below pass while proving nothing.
  const appUrl = new URL(ADMIN_URL);
  appUrl.username = APP_ROLE;
  appUrl.password = APP_ROLE;
  appUrl.pathname = `/${scratchName}`;
  runtime = createDatabaseRuntime({ databaseUrl: appUrl.toString(), maxConnections: 4 });

  registry = await loadConnectorPackages([contract()]);
  if (!registry.loaded.has(SLUG)) {
    throw new Error(`package did not load: ${JSON.stringify(registry.failures)}`);
  }
}, 120_000);

afterAll(async () => {
  await runtime?.close();
  await admin?.unsafe(`drop database if exists "${scratchName}" with (force)`);
  await admin?.close();
});

/** A stubbed upstream, injected by replacing global fetch for one call. */
async function withUpstream<T>(
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
  run: () => Promise<T>,
): Promise<{ result: T; calls: { url: URL; init?: RequestInit }[] }> {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push({ url, ...(init ? { init } : {}) });
    return handler(url, init);
  }) as typeof fetch;
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

describe("the full dispatch chain", () => {
  test("configure → enable → invoke returns a validated result", async () => {
    await configureConnector(catalogContext(TENANT, [CONNECTOR_ADMIN_ROLE]), {
      slug: SLUG,
      configuration: {
        endpoint: "https://eu.objectstore.example",
        region: "eu-west",
        accessKeyId: "AKIA-DISPATCH",
        secretAccessKey: "dispatch-secret-value",
      },
    });
    expect(
      await setConnectorEnabled(
        catalogContext(TENANT, [CONNECTOR_ADMIN_ROLE]),
        SLUG,
        "default",
        true,
      ),
    ).toBe(true);

    const egressRequests: ModuleEgressRequest[] = [];
    const trustedSource = {
      sourceReference: "msr1.connector-dispatch-source",
      scope: "personal" as const,
    };
    const { result, calls } = await withUpstream(
      () => Response.json({ objects: [{ key: "a/1.txt", size: 7 }] }),
      () =>
        invokeConnectorOperation(
          {
            ...invocationContext(TENANT, ["Connectors.All.Read"]),
            egressSource: trustedSource,
            egressOwner: {
              fetch: async (request) => {
                egressRequests.push(request);
                return fetch(request.url, request.init);
              },
            },
          },
          contract(),
          operation("listObjects"),
          { prefix: "a/" },
        ),
    );

    expect(result).toEqual([{ key: "a/1.txt", sizeBytes: 7 }]);
    expect(egressRequests).toHaveLength(1);
    expect(egressRequests[0]?.source).toEqual(trustedSource);
    // The stored configuration reached the package…
    expect(calls[0]?.url.origin).toBe("https://eu.objectstore.example");
    // …and so did the decrypted secret, without ever passing through a read API.
    const auth = new Headers(calls[0]?.init?.headers as HeadersInit).get("authorization");
    expect(auth).toBe(`Basic ${btoa("AKIA-DISPATCH:dispatch-secret-value")}`);
  });

  // The gate that could not be written before dispatch existed.
  test("an unauthorized session executes no package code", async () => {
    let reached = false;
    const { calls } = await withUpstream(
      () => {
        reached = true;
        return Response.json({ objects: [] });
      },
      async () => {
        await expect(
          invokeConnectorOperation(
            // Holds a role, but not this operation's.
            invocationContext(TENANT, ["Relaties.All.Read"]),
            contract(),
            operation("listObjects"),
            {},
          ),
        ).rejects.toThrow(/Not authorized/);
      },
    );
    expect(reached).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("another tenant cannot reach this tenant's installation", async () => {
    await expect(
      invokeConnectorOperation(
        invocationContext(OTHER_TENANT, ["Connectors.All.Read"]),
        contract(),
        operation("listObjects"),
        {},
      ),
    ).rejects.toThrow(/no installation/);
  });

  test("a disabled installation refuses with its own code", async () => {
    await setConnectorEnabled(
      catalogContext(TENANT, [CONNECTOR_ADMIN_ROLE]),
      SLUG,
      "default",
      false,
    );
    await expect(
      invokeConnectorOperation(
        invocationContext(TENANT, ["Connectors.All.Read"]),
        contract(),
        operation("listObjects"),
        {},
      ),
    ).rejects.toThrow(/disabled/);
    await setConnectorEnabled(
      catalogContext(TENANT, [CONNECTOR_ADMIN_ROLE]),
      SLUG,
      "default",
      true,
    );
  });

  test("the idempotency key reaches the upstream on the mutation", async () => {
    const { calls } = await withUpstream(
      () => Response.json({ ok: true }),
      () =>
        invokeConnectorOperation(
          invocationContext(TENANT, ["Connectors.All.ReadWrite"]),
          contract(),
          operation("putObject"),
          { key: "a/2.txt", requestId: "req-dispatch-1" },
        ),
    );
    const sent = new Headers(calls[0]?.init?.headers as HeadersInit);
    expect(sent.get("Idempotency-Key")).toBe("req-dispatch-1");
  });

  test("an upstream failure surfaces classified and redacted", async () => {
    let caught: ConnectorExecutionError | undefined;
    await withUpstream(
      () => new Response("secret internal detail", { status: 500 }),
      async () => {
        try {
          await invokeConnectorOperation(
            invocationContext(TENANT, ["Connectors.All.Read"]),
            contract(),
            operation("listObjects"),
            {},
          );
        } catch (error) {
          caught = error as ConnectorExecutionError;
        }
      },
    );
    expect(caught?.code).toBe("CONNECTOR_PROVIDER_UNAVAILABLE");
    expect(caught?.message).toMatch(/provider is unavailable\.$/);
    expect(caught?.message).not.toContain("secret internal detail");
    expect(caught?.outcome).toMatchObject({ category: "availability", requiredAction: "wait" });
  });

  // The whole chain, for the outcome this issue exists for: the provider's
  // 429 reaches the caller as a rate limit with its retry time, is journalled
  // under the audit allowlist, and mutates nothing about the installation.
  test("a provider 429 becomes a rate-limit outcome with retryAt, and is journalled", async () => {
    let caught: ConnectorExecutionError | undefined;
    const before = Date.now();
    await withUpstream(
      () =>
        new Response("slow down: secret quota detail", {
          status: 429,
          headers: { "retry-after": "30", "x-provider-request-id": "prov-req-1" },
        }),
      async () => {
        try {
          await invokeConnectorOperation(
            invocationContext(TENANT, ["Connectors.All.Read"]),
            contract(),
            operation("listObjects"),
            {},
          );
        } catch (error) {
          caught = error as ConnectorExecutionError;
        }
      },
    );
    expect(caught?.code).toBe("CONNECTOR_PROVIDER_RATE_LIMITED");
    expect(caught?.outcome).toMatchObject({
      category: "rate_limit",
      retryable: true,
      requiredAction: "wait",
    });
    expect(Date.parse(caught!.outcome!.retryAt!)).toBeGreaterThanOrEqual(before + 30_000);

    const events = await runtime.db.connection().execute(async (conn) => {
      await sql`select set_config('app.tenant_id', ${TENANT}, false)`.execute(conn);
      return sql<{ tenant_id: string; event_type: string; payload: Record<string, unknown> }>`
        select tenant_id::text, event_type, payload from platform.entity_events
         where aggregate_type = ${CONNECTOR_AGGREGATE}
           and event_type = 'connector.provider_failed'
         order by sequence desc
         limit 1
      `.execute(conn);
    });
    const journalled = events.rows[0]?.payload.providerFailure as Record<string, unknown>;
    expect(events.rows[0]?.tenant_id).toBe(TENANT);
    expect(events.rows[0]?.payload).toMatchObject({
      connectorSlug: SLUG,
      instanceKey: "default",
    });
    expect(journalled).toEqual({
      correlationId: caught!.outcome!.correlationId,
      operationKey: "listObjects",
      providerStatus: 429,
      code: "CONNECTOR_PROVIDER_RATE_LIMITED",
      retryable: true,
      retryAt: caught!.outcome!.retryAt,
    });
    const serialized = JSON.stringify(events.rows[0]);
    expect(serialized).not.toContain("secret quota detail");
    expect(serialized).not.toContain("prov-req-1");
    expect(serialized).not.toContain("eu.objectstore.example");
    expect(serialized).not.toContain("AKIA-DISPATCH");
    expect(serialized).not.toContain("dispatch-secret-value");

    const metric = getProcessPrometheusRegistry().getSingleMetric(
      "openshapeforge_connector_provider_failures_total",
    );
    const samples = (await metric?.get())?.values ?? [];
    expect(samples).toContainEqual(
      expect.objectContaining({
        labels: {
          connector: SLUG,
          operation: "listObjects",
          code: "CONNECTOR_PROVIDER_RATE_LIMITED",
        },
      }),
    );
    for (const sample of samples) {
      expect(Object.keys(sample.labels).sort()).toEqual(["code", "connector", "operation"]);
    }

    // Still enabled, still usable: a provider refusal is not a lifecycle event.
    const { result } = await withUpstream(
      () => Response.json({ objects: [] }),
      () =>
        invokeConnectorOperation(
          invocationContext(TENANT, ["Connectors.All.Read"]),
          contract(),
          operation("listObjects"),
          {},
        ),
    );
    expect(result).toEqual([]);
  });
});

describe("verify", () => {
  test("reports unsupported when the package implements no check", async () => {
    await expect(
      verifyConnectorInstallation(
        invocationContext(TENANT, [CONNECTOR_ADMIN_ROLE]),
        contract(),
      ),
    ).rejects.toThrow(/does not implement a connectivity check/);
  });
});

describe("audit trail", () => {
  test("configuration and enable are journaled with field names, never values", async () => {
    const events = await runtime.db
      .connection()
      .execute(async (conn) => {
        await sql`select set_config('app.tenant_id', ${TENANT}, false)`.execute(conn);
        return sql<{ event_type: string; payload: unknown }>`
          select event_type, payload from platform.entity_events
           where aggregate_type = ${CONNECTOR_AGGREGATE}
           order by sequence
        `.execute(conn);
      });

    const types = events.rows.map((row) => row.event_type);
    expect(types).toContain("connector.configured");
    expect(types).toContain("connector.enabled");

    const serialized = JSON.stringify(events.rows);
    // Field NAMES are recorded…
    expect(serialized).toContain("accessKeyId");
    // …and never a value, secret or otherwise.
    expect(serialized).not.toContain("dispatch-secret-value");
    expect(serialized).not.toContain("AKIA-DISPATCH");
    expect(serialized).not.toContain("eu.objectstore.example");
  });
});

describe("secret rotation", () => {
  test("re-encrypts stored secrets under the active key, idempotently", async () => {
    const before = await runtime.db.connection().execute(async (conn) => {
      await sql`select set_config('app.tenant_id', ${TENANT}, false)`.execute(conn);
      return sql<{ key_id: string }>`
        select key_id from platform.connector_secrets order by field_key
      `.execute(conn);
    });
    expect(before.rows.every((row) => row.key_id === "k1")).toBe(true);

    const first = await rotateSecrets(runtime.db, session(TENANT), rotatedKeyring);
    expect(first.rotated).toBe(before.rows.length);
    expect(first.skipped).toBe(0);

    // Idempotent: a second pass finds nothing left to move.
    const second = await rotateSecrets(runtime.db, session(TENANT), rotatedKeyring);
    expect(second.rotated).toBe(0);
    expect(second.skipped).toBe(before.rows.length);

    // And the plaintext survived the move: the package still authenticates the
    // same way, which is the only thing rotation must not change.
    const { calls } = await withUpstream(
      () => Response.json({ objects: [] }),
      () =>
        invokeConnectorOperation(
          { ...invocationContext(TENANT, ["Connectors.All.Read"]), keyring: rotatedKeyring },
          contract(),
          operation("listObjects"),
          {},
        ),
    );
    const auth = new Headers(calls[0]?.init?.headers as HeadersInit).get("authorization");
    expect(auth).toBe(`Basic ${btoa("AKIA-DISPATCH:dispatch-secret-value")}`);
  });
});
