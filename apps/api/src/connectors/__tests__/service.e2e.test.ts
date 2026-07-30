// SPDX-License-Identifier: BUSL-1.1
/**
 * Stage 4 gates, against a real database.
 *
 * Exercises the service the GraphQL and REST surfaces both delegate to, with
 * real RLS sessions, real encryption, and a real signed licence — so what is
 * proved here is what those surfaces do, not a mock of it.
 *
 * Needs the compose Postgres up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes, randomUUID, sign as signEd25519 } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { keyringFromEnv } from "../secrets.js";
import {
  configureConnector,
  describeConnector,
  listConnectors,
  setConnectorEnabled,
  type CatalogContext,
  type ConnectorRuntimeConfig,
} from "../service.js";
import type { ConnectorContract } from "../catalog.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";

const NOW = 1_800_000_000_000;
const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const USER = randomUUID();
const ENTITLEMENT = "connector.object-store";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const LICENSE_PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" }).toString();

function issueLicense(entitlements: string[]): string {
  const payload = Buffer.from(JSON.stringify({ entitlements }), "utf8");
  return `${payload.toString("base64url")}.${signEd25519(null, payload, privateKey).toString("base64url")}`;
}

/** A licensed connector contract, injected into the catalog for this suite. */
const CONTRACT: ConnectorContract = {
  slug: "object-store",
  connector: "ObjectStore",
  title: "Object storage",
  domains: [],
  capabilities: ["operations"],
  implementation: {
    package: "@scope/connector-object-store",
    contractVersion: 1,
    provenance: "firstParty",
    license: { spdx: "LicenseRef-BatterAI-Commercial" },
  },
  availability: { entitlement: ENTITLEMENT },
  configuration: {
    instances: "single",
    verify: false,
    fields: [
      { key: "endpoint", required: true },
      { key: "region" },
      { key: "apiKey", secret: true, required: true },
    ],
    secretFields: ["apiKey"],
    schema: {
      type: "object",
      properties: {
        endpoint: { type: "string" },
        region: { type: "string" },
        apiKey: { type: "string", minLength: 4 },
      },
      required: ["endpoint"],
      additionalProperties: false,
    },
  },
  network: { egress: [] },
  operations: [],
  exposure: { graphql: true },
  namespace: "objectStore",
  checksum: "checksum-v1",
};

let scratchName: string;
let runtime: DatabaseRuntime;
let admin: SQL;

/**
 * The suite connects as the RESTRICTED app role, not the privileged one that
 * runs the migration chain. A superuser bypasses RLS, so a suite connected as
 * one would show every tenant's rows to every tenant — and the isolation
 * assertions below would pass while proving nothing.
 */
const APP_ROLE = "openshapeforge_app";
const APP_ROLE_PASSWORD = "openshapeforge_app";

const keyring = keyringFromEnv(`k1:${randomBytes(32).toString("base64")}`)!;

function config(overrides: Partial<ConnectorRuntimeConfig> = {}): ConnectorRuntimeConfig {
  return {
    licensePublicKey: LICENSE_PUBLIC_KEY,
    licenseToken: issueLicense([ENTITLEMENT]),
    keyring,
    installedPackages: new Set(["object-store"]),
    ...overrides,
  };
}

function context(
  tenantId: string,
  overrides: Partial<ConnectorRuntimeConfig> = {},
  contracts: ConnectorContract[] = [CONTRACT],
): CatalogContext {
  return {
    db: runtime.db,
    session: { tenantId, userId: USER, roles: [], groups: [], scope: "tenant" },
    config: config(overrides),
    now: NOW,
    contracts,
  };
}

beforeAll(async () => {
  scratchName = `connector_service_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  admin = new SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`create database "${scratchName}"`);

  // Migrate as the privileged role: the chain provisions the app role itself.
  const adminUrl = new URL(ADMIN_URL);
  adminUrl.pathname = `/${scratchName}`;
  const adminRuntime = createDatabaseRuntime({
    databaseUrl: adminUrl.toString(),
    maxConnections: 1,
  });
  await adminRuntime.db.connection().execute((conn) => runMigrationChain(conn));
  // Seed grants as the privileged role, which bypasses the tenant WITH CHECK.
  for (const tenant of [TENANT_A, TENANT_B]) {
    await sql`
      insert into platform.connector_entitlements (tenant_id, entitlement)
      values (${tenant}::uuid, ${ENTITLEMENT})
    `.execute(adminRuntime.db);
  }
  await adminRuntime.close();

  const appUrl = new URL(ADMIN_URL);
  appUrl.username = APP_ROLE;
  appUrl.password = APP_ROLE_PASSWORD;
  appUrl.pathname = `/${scratchName}`;
  runtime = createDatabaseRuntime({ databaseUrl: appUrl.toString(), maxConnections: 2 });
}, 120_000);

afterAll(async () => {
  await runtime?.close();
  await admin?.unsafe(`drop database if exists "${scratchName}" with (force)`);
  await admin?.close();
});

describe("catalog", () => {
  test("a licensed but unconfigured connector reports NOT_CONFIGURED", async () => {
    const [view] = await listConnectors(context(TENANT_A));
    expect(view?.slug).toBe("object-store");
    expect(view?.status).toBe("NOT_CONFIGURED");
    // The contract is visible even before anything is installed — that is what
    // makes a locked connector advertisable.
    expect(view?.configFields.map((field) => field.key)).toEqual([
      "endpoint",
      "region",
      "apiKey",
    ]);
  });

  test("an unlicensed deployment sees NOT_LICENSED, not the package state", async () => {
    const [view] = await listConnectors(
      context(TENANT_A, { licenseToken: issueLicense([]) }),
    );
    expect(view?.status).toBe("NOT_LICENSED");
  });

  test("a tenant without a grant sees NOT_LICENSED even on a licensed deployment", async () => {
    const tenantWithoutGrant = randomUUID();
    const [view] = await listConnectors(context(tenantWithoutGrant));
    expect(view?.status).toBe("NOT_LICENSED");
  });
});

describe("configuration", () => {
  test("stores non-secret config, encrypts the secret, and never returns it", async () => {
    const installation = await configureConnector(context(TENANT_A), {
      slug: "object-store",
      configuration: {
        endpoint: "https://store.example",
        region: "eu-west",
        apiKey: "super-secret-key",
      },
    });

    expect(installation.configuration).toEqual({
      endpoint: "https://store.example",
      region: "eu-west",
      apiKey: "__set__",
    });

    // The ciphertext column must not contain the plaintext anywhere.
    const stored = await sql<{ ciphertext: string }>`
      select ciphertext from platform.connector_secrets
    `.execute(runtime.db);
    for (const row of stored.rows) {
      expect(row.ciphertext).not.toContain("super-secret-key");
      expect(Buffer.from(row.ciphertext, "base64").toString("utf8")).not.toContain(
        "super-secret-key",
      );
    }
  });

  test("rejects an unknown configuration key rather than dropping it", async () => {
    await expect(
      configureConnector(context(TENANT_A), {
        slug: "object-store",
        configuration: { endpoint: "https://store.example", endpoin: "typo", apiKey: "abcd" },
      }),
    ).rejects.toThrow(/unknown field "endpoin"/);
  });

  test("refuses to configure a connector the tenant is not licensed for", async () => {
    await expect(
      configureConnector(context(TENANT_A, { licenseToken: issueLicense([]) }), {
        slug: "object-store",
        configuration: { endpoint: "https://store.example", apiKey: "abcd" },
      }),
    ).rejects.toThrow(/not licensed/);
  });

  test("refuses configuration when no encryption keyring is configured", async () => {
    await expect(
      configureConnector(context(TENANT_A, { keyring: undefined }), {
        slug: "object-store",
        configuration: { endpoint: "https://store.example", apiKey: "abcd" },
      }),
    ).rejects.toThrow(/secret encryption is not configured/i);
  });

  test("a second tenant's configuration is invisible to the first", async () => {
    await configureConnector(context(TENANT_B), {
      slug: "object-store",
      configuration: { endpoint: "https://tenant-b.example", apiKey: "tenant-b-key" },
    });

    const viewA = await describeConnector(context(TENANT_A), "object-store");
    expect(viewA?.installations).toHaveLength(1);
    expect(viewA?.installations[0]?.configuration.endpoint).toBe("https://store.example");

    const viewB = await describeConnector(context(TENANT_B), "object-store");
    expect(viewB?.installations).toHaveLength(1);
    expect(viewB?.installations[0]?.configuration.endpoint).toBe("https://tenant-b.example");
  });
});

describe("enable and drift", () => {
  test("enabling a current installation makes the connector AVAILABLE", async () => {
    expect(await setConnectorEnabled(context(TENANT_A), "object-store", "default", true)).toBe(
      true,
    );
    const view = await describeConnector(context(TENANT_A), "object-store");
    expect(view?.status).toBe("AVAILABLE");
    expect(view?.installations[0]?.contract.state).toBe("CURRENT");
  });

  // Review point 7: a compiled contract that now requires a field the stored
  // configuration lacks must surface as needing repair, not fail at call time.
  test("an installation missing a newly required field cannot be enabled", async () => {
    const evolved: ConnectorContract = {
      ...CONTRACT,
      checksum: "checksum-v2",
      configuration: {
        ...CONTRACT.configuration,
        fields: [...CONTRACT.configuration.fields, { key: "bucket", required: true }],
      },
    };
    // Same stored installation, newer compiled contract — exactly what a
    // deployment does when it ships a contract change.
    const evolvedContext = context(TENANT_A, {}, [evolved]);

    const view = await describeConnector(evolvedContext, "object-store");
    expect(view?.installations[0]?.contract.state).toBe("NEEDS_REPAIR");
    expect(view?.installations[0]?.contract.missingRequiredFields).toEqual(["bucket"]);

    await expect(
      setConnectorEnabled(evolvedContext, "object-store", "default", true),
    ).rejects.toThrow(/cannot be enabled/);
  });

  test("disabling reports DISABLED again", async () => {
    await setConnectorEnabled(context(TENANT_A), "object-store", "default", false);
    const view = await describeConnector(context(TENANT_A), "object-store");
    expect(view?.status).toBe("DISABLED");
  });
});
