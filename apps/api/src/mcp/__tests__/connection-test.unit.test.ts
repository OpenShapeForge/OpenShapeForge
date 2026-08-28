// SPDX-License-Identifier: BUSL-1.1
/**
 * Unit coverage for elicited-row verification: the honest three-check report
 * (required values, credential resolution, declared probe), including the
 * egress gate on probes, per-field secret scoping, and the skipped outcomes
 * that keep "shaped correctly" distinct from "works".
 */
import { describe, expect, it } from "bun:test";
import { testElicitedRow } from "../connection-test.js";
import type { ElicitOnCreateEntry } from "../elicitation.js";
import { encryptSecret, keyringFromEnv } from "../../connectors/secrets.js";

const KEYRING = keyringFromEnv(`test:${Buffer.alloc(32, 7).toString("base64")}`)!;
const TABLE = "core.connections";
const ELICIT: ElicitOnCreateEntry = {
  sourceField: "providerId",
  sourceEntity: "Provider",
  sourceTable: "core.providers",
  definitionsField: "definitions",
  into: "values",
};

const SOURCE = {
  id: "prov-1",
  name: "Ticketing",
  baseUrlTemplate: "https://{subdomain}.example.com",
  egressHosts: ["*.example.com"],
  auth: { scheme: "basic", usernameTemplate: "{email}/token", passwordFrom: "apiToken" },
  definitions: [
    { key: "subdomain", required: true },
    { key: "email", required: true },
    { key: "apiToken", required: true },
  ],
};

function values(overrides: Record<string, unknown> = {}) {
  return {
    subdomain: "acme",
    email: "a@b.c",
    apiToken: encryptSecret(KEYRING, ELICIT.sourceTable, "apiToken", "tok-1"),
    ...overrides,
  };
}

const refusingFetch: typeof fetch = (() => {
  throw new Error("no network expected");
}) as unknown as typeof fetch;

describe("testElicitedRow", () => {
  it("reports missing required values and skips the probe without one declared", async () => {
    const report = await testElicitedRow({
      row: { id: "c1", values: { subdomain: "acme" } },
      sourceRow: SOURCE,
      elicit: ELICIT,
      table: TABLE,
      keyring: KEYRING,
      fetchImpl: refusingFetch,
    });
    expect(report.ok).toBe(false);
    expect(report.source).toBe("Ticketing");
    const required = report.checks.find((check) => check.check === "required-values");
    expect(required?.outcome).toBe("failed");
    expect(required?.detail).toContain("apiToken, email");
    expect(report.checks.find((check) => check.check === "probe")?.outcome).toBe("skipped");
  });

  it("passes credentials locally and reports the probe as skipped when undeclared", async () => {
    const report = await testElicitedRow({
      row: { id: "c1", values: values() },
      sourceRow: SOURCE,
      elicit: ELICIT,
      table: TABLE,
      keyring: KEYRING,
      fetchImpl: refusingFetch,
    });
    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.outcome)).toEqual(["passed", "passed", "skipped"]);
    expect(JSON.stringify(report)).not.toContain("tok-1");
  });

  it("sends a declared probe with resolved auth and judges the status", async () => {
    const seen: { url?: string | undefined; auth?: string | undefined } = {};
    const okFetch: typeof fetch = (async (url: URL | string, init?: RequestInit) => {
      seen.url = String(url);
      seen.auth = (init?.headers as Record<string, string>).authorization;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const report = await testElicitedRow({
      row: { id: "c1", values: values() },
      sourceRow: { ...SOURCE, probe: { method: "GET", pathTemplate: "/api/me" } },
      elicit: ELICIT,
      table: TABLE,
      keyring: KEYRING,
      fetchImpl: okFetch,
    });
    expect(report.ok).toBe(true);
    expect(seen.url).toBe("https://acme.example.com/api/me");
    expect(seen.auth).toBe(`Basic ${Buffer.from("a@b.c/token:tok-1").toString("base64")}`);
    expect(report.checks.find((check) => check.check === "probe")?.detail).toContain("200");

    const refused = await testElicitedRow({
      row: { id: "c1", values: values() },
      sourceRow: { ...SOURCE, probe: { pathTemplate: "/api/me" } },
      elicit: ELICIT,
      table: TABLE,
      keyring: KEYRING,
      fetchImpl: (async () => new Response("no", { status: 401 })) as unknown as typeof fetch,
    });
    expect(refused.ok).toBe(false);
    expect(refused.checks.find((check) => check.check === "probe")?.detail).toContain(
      "refused these credentials",
    );
  });

  it("refuses a probe whose host is outside the egress allow-list", async () => {
    const report = await testElicitedRow({
      row: { id: "c1", values: values() },
      sourceRow: {
        ...SOURCE,
        egressHosts: ["elsewhere.com"],
        probe: { pathTemplate: "/api/me" },
      },
      elicit: ELICIT,
      table: TABLE,
      keyring: KEYRING,
      fetchImpl: refusingFetch,
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.check === "probe")?.detail).toContain(
      "egress allow-list",
    );
  });

  it("treats a sign-in client connection honestly: nothing to exercise yet", async () => {
    const report = await testElicitedRow({
      row: {
        id: "c1",
        values: {
          clientId: "cid",
          clientSecret: encryptSecret(KEYRING, ELICIT.sourceTable, "clientSecret", "cs"),
        },
      },
      sourceRow: {
        ...SOURCE,
        auth: { profile: "oauth2AuthorizationCode", authorizationUrl: "https://a", tokenUrl: "https://t" },
        definitions: [],
      },
      elicit: ELICIT,
      table: TABLE,
      keyring: KEYRING,
      fetchImpl: refusingFetch,
    });
    expect(report.ok).toBe(true);
    const credentials = report.checks.find((check) => check.check === "credentials");
    expect(credentials?.outcome).toBe("skipped");
    expect(credentials?.detail).toContain("per person");
  });

  it("verifies a personal token row with the personal secret scope", async () => {
    const seen: { auth?: string | undefined; url?: string | undefined } = {};
    const report = await testElicitedRow({
      row: {
        id: "c2",
        ownerUserId: "user-1",
        values: {
          accessToken: encryptSecret(KEYRING, `${TABLE}:personal`, "accessToken", "at-1"),
        },
      },
      sourceRow: {
        ...SOURCE,
        auth: { profile: "oauth2AuthorizationCode" },
        probe: { pathTemplate: "/api/me" },
        definitions: [],
      },
      elicit: ELICIT,
      table: TABLE,
      keyring: KEYRING,
      // A personal row holds tokens only; the tenant sibling's plain values
      // resolve the URL templates, exactly as execution merges them.
      fallbackPlainValues: { subdomain: "acme" },
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        seen.auth = (init?.headers as Record<string, string>).authorization;
        seen.url = String(url);
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(report.ok).toBe(true);
    expect(seen.url).toBe("https://acme.example.com/api/me");
    expect(seen.auth).toBe("Bearer at-1");
    expect(report.checks.find((check) => check.check === "probe")?.outcome).toBe("passed");
  });
});
