// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateProductionEnv as validateAdminProductionEnv } from "../apps/admin/src/lib/auth/validate-env";
import { validateProductionEnv as validateWebProductionEnv } from "../apps/web/src/lib/auth/validate-env";
import { createNextConfig as createAdminNextConfig } from "../apps/admin/next.config";
import { createNextConfig as createWebNextConfig } from "../apps/web/next.config";

type AuthEnvironment = Record<string, string | undefined>;
type Validator = (env: AuthEnvironment) => void;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const validators: Array<[name: string, validate: Validator]> = [
  ["web", validateWebProductionEnv],
  ["admin", validateAdminProductionEnv],
];

const nextConfigs = [
  ["web", createWebNextConfig],
  ["admin", createAdminNextConfig],
] as const;

function secureProductionEnv(overrides: AuthEnvironment = {}): AuthEnvironment {
  return {
    NODE_ENV: "production",
    AUTH_SECRET: "review-only-auth-secret",
    AUTH_KEYCLOAK_ID: "review-client",
    AUTH_KEYCLOAK_SECRET: "review-only-client-secret",
    AUTH_KEYCLOAK_ISSUER: "https://identity.example.test/realms/review",
    AUTH_URL: "https://app.example.test",
    AUTH_COOKIE_SECURE: "true",
    REDIS_URL: "rediss://redis.example.test:6380",
    ...overrides,
  };
}

function loopbackPreviewEnv(host: string): AuthEnvironment {
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return {
    NODE_ENV: "production",
    HOSTNAME: host,
    OPENSHAPEFORGE_LOCAL_PRODUCTION_PREVIEW: "true",
    AUTH_KEYCLOAK_ISSUER: `http://${urlHost}:8181/realms/review`,
    AUTH_URL: `http://${urlHost}:3000`,
    AUTH_COOKIE_SECURE: "false",
    REDIS_URL: `redis://${urlHost}:6379`,
  };
}

async function runInvalidProductionStart(app: "web" | "admin") {
  const env = { ...process.env };
  delete env.OPENSHAPEFORGE_LOCAL_PRODUCTION_PREVIEW;
  Object.assign(env, secureProductionEnv({
    AUTH_KEYCLOAK_ISSUER: "http://identity.example.test/realms/review",
    NEXT_PHASE: "phase-production-build",
  }));

  const processHandle = Bun.spawn([
    "node",
    join(REPO_ROOT, "apps", app, ".next", "standalone", "apps", app, "server.js"),
  ], {
    cwd: join(REPO_ROOT, "apps", app),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => processHandle.kill(), 10_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]).finally(() => clearTimeout(timeout));

  return { exitCode, output: `${stdout}\n${stderr}` };
}

async function runPreviewProductionStart(
  app: "web" | "admin",
  hostname: string,
) {
  const port = app === "web" ? 39_981 : 39_982;
  const env = { ...process.env };
  for (const envVar of [
    "AUTH_SECRET",
    "NEXTAUTH_SECRET",
    "AUTH_COOKIE_DOMAIN",
    "AUTH_KEYCLOAK_ISSUER_INTERNAL",
  ]) {
    delete env[envVar];
  }
  Object.assign(env, loopbackPreviewEnv("127.0.0.1"), {
    HOSTNAME: hostname,
    PORT: String(port),
    AUTH_URL: `http://127.0.0.1:${port}`,
    // The supported launcher must replace a polluted build phase before it
    // validates runtime state.
    NEXT_PHASE: "phase-production-build",
  });

  const processHandle = Bun.spawn([
    "node",
    join(REPO_ROOT, "apps", app, ".next", "standalone", "apps", app, "server.js"),
  ], {
    cwd: join(REPO_ROOT, "apps", app),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  let listening = false;
  for (let attempt = 0; attempt < 100 && processHandle.exitCode === null; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}`, { redirect: "manual" });
      listening = true;
      break;
    } catch {
      await Bun.sleep(100);
    }
  }
  if (processHandle.exitCode === null) {
    processHandle.kill();
  }
  const timeout = setTimeout(() => processHandle.kill(9), 2_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]).finally(() => clearTimeout(timeout));

  return { exitCode, listening, output: `${stdout}\n${stderr}` };
}

for (const [name, validate] of validators) {
  describe(`${name} production auth environment`, () => {
    test("does not apply production-only requirements outside production", () => {
      expect(() => validate({ NODE_ENV: "development" })).not.toThrow();
    });

    test("does not require runtime secrets during a production build", () => {
      expect(() =>
        validate({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build" })
      ).not.toThrow();
    });

    test.each(["localhost", "127.42.1.2", "::1", "::ffff:127.0.0.1"])(
      "keeps the explicit loopback-only preview available on %s",
      (host) => {
        expect(() => validate(loopbackPreviewEnv(host))).not.toThrow();
      },
    );

    test("requires an explicit local-preview opt-in and application origin", () => {
      expect(() =>
        validate({
          ...loopbackPreviewEnv("localhost"),
          OPENSHAPEFORGE_LOCAL_PRODUCTION_PREVIEW: undefined,
        })
      ).toThrow("AUTH_SECRET or NEXTAUTH_SECRET must be configured");

      expect(() =>
        validate({
          ...loopbackPreviewEnv("localhost"),
          AUTH_URL: undefined,
          NEXTAUTH_URL: undefined,
        })
      ).toThrow("AUTH_SECRET or NEXTAUTH_SECRET must be configured");
    });

    test.each([undefined, "0.0.0.0", "::", "app.example.test"])(
      "rejects local-preview transport on the non-loopback listener %s",
      (hostname) => {
        expect(() => validate({
          ...loopbackPreviewEnv("127.0.0.1"),
          HOSTNAME: hostname,
        })).toThrow("AUTH_SECRET or NEXTAUTH_SECRET must be configured");
      },
    );

    test("accepts encrypted remote transport with a secure host-only cookie", () => {
      expect(() => validate(secureProductionEnv())).not.toThrow();
    });

    test("accepts NEXTAUTH_URL as the explicit secure application origin", () => {
      expect(() =>
        validate(secureProductionEnv({
          AUTH_URL: undefined,
          NEXTAUTH_URL: "https://app.example.test",
        }))
      ).not.toThrow();
    });

    test("does not treat malformed loopback-looking URLs as a local preview", () => {
      expect(() =>
        validate({
          ...loopbackPreviewEnv("localhost"),
          AUTH_KEYCLOAK_ISSUER_INTERNAL: "http://[::1",
        })
      ).toThrow("AUTH_SECRET or NEXTAUTH_SECRET must be configured");
    });

    test.each(["127.attacker.example", "::ffff:7f00:1:2"])(
      "rejects the non-loopback lookalike %s",
      (host) => {
        expect(() => validate(loopbackPreviewEnv(host))).toThrow(
          "AUTH_SECRET or NEXTAUTH_SECRET must be configured",
        );
      },
    );

    test("rejects an insecure browser-facing issuer", () => {
      expect(() =>
        validate(secureProductionEnv({
          AUTH_KEYCLOAK_ISSUER: "http://identity.example.test/realms/review",
        }))
      ).toThrow("AUTH_KEYCLOAK_ISSUER must use https:");
    });

    test("rejects an insecure server-facing issuer override", () => {
      expect(() =>
        validate(secureProductionEnv({
          AUTH_KEYCLOAK_ISSUER_INTERNAL: "http://identity.internal/realms/review",
        }))
      ).toThrow("AUTH_KEYCLOAK_ISSUER_INTERNAL must use https:");
    });

    test("rejects an insecure or missing application origin", () => {
      expect(() =>
        validate(secureProductionEnv({ AUTH_URL: "http://app.example.test" }))
      ).toThrow("AUTH_URL must use https:");
      expect(() =>
        validate(secureProductionEnv({ AUTH_URL: undefined, NEXTAUTH_URL: undefined }))
      ).toThrow("AUTH_URL or NEXTAUTH_URL is not configured");
    });

    test("rejects a non-TLS Redis session store", () => {
      expect(() =>
        validate(secureProductionEnv({ REDIS_URL: "redis://redis.example.test:6379" }))
      ).toThrow("REDIS_URL must use rediss:");
    });

    test("rejects a non-secure production cookie", () => {
      expect(() =>
        validate(secureProductionEnv({ AUTH_COOKIE_SECURE: "false" }))
      ).toThrow('AUTH_COOKIE_SECURE must be set to "true"');
    });

    test("rejects a Domain attribute so the session cookie remains host-only", () => {
      expect(() =>
        validate(secureProductionEnv({ AUTH_COOKIE_DOMAIN: ".example.test" }))
      ).toThrow("AUTH_COOKIE_DOMAIN must be unset");

      expect(() =>
        validate(secureProductionEnv({ AUTH_COOKIE_DOMAIN: "   " }))
      ).toThrow("AUTH_COOKIE_DOMAIN must be unset");
    });
  });
}

for (const [name, createNextConfig] of nextConfigs) {
  describe(`${name} startup auth validation`, () => {
    test("rejects an insecure production environment while loading server config", () => {
      expect(() =>
        createNextConfig(
          "phase-production-server",
          secureProductionEnv({
            AUTH_KEYCLOAK_ISSUER: "http://identity.example.test/realms/review",
          }),
        )
      ).toThrow("AUTH_KEYCLOAK_ISSUER must use https:");
    });

    test("keeps runtime secrets out of the production build phase", () => {
      expect(() =>
        createNextConfig("phase-production-build", { NODE_ENV: "production" })
      ).not.toThrow();
    });
  });
}

for (const app of ["web", "admin"] as const) {
  test(`${app} raw standalone server refuses insecure config before listening`, async () => {
    const result = await runInvalidProductionStart(app);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("AUTH_KEYCLOAK_ISSUER must use https:");
    expect(result.output).not.toContain("Ready");
    expect(result.output).not.toContain("Network:");
  }, 15_000);

  test(`${app} preview refuses a non-loopback listener before Next listens`, async () => {
    const result = await runPreviewProductionStart(app, "0.0.0.0");
    expect(result.exitCode).not.toBe(0);
    expect(result.listening).toBe(false);
    expect(result.output).toContain("FATAL:");
    expect(result.output).not.toContain("Ready");
    expect(result.output).not.toContain("Network:");
  }, 15_000);

  test(`${app} preview starts only on an explicit loopback listener`, async () => {
    const result = await runPreviewProductionStart(app, "127.0.0.1");
    expect(result.listening).toBe(true);
    expect(result.output).toContain("Ready");
    expect(result.output).toContain("127.0.0.1");
    expect(result.output).not.toContain("0.0.0.0");
  }, 15_000);
}
