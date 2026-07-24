/**
 * Pure unit tests for assertProductionEnv. No database or network — every case
 * passes a fabricated env object, so these run fast and hermetically.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/config 2>&1
 */
import { describe, expect, test } from "bun:test";
import {
  DEV_CONTEXT_SECRET_DEFAULT,
  assertProductionEnv,
} from "../production-guard.js";

const JWKS = "https://idp.example/realms/x/protocol/openid-connect/certs";
const ISSUER = "https://idp.example/realms/x";
const STRONG_SECRET = "a-strong-randomized-production-secret-0123456789";

/** A fully-configured, safe production env (bearer complete + strong secret). */
function safeProdEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI: JWKS,
    OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER: ISSUER,
    OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE: "erp-provider",
    OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET: STRONG_SECRET,
  } as NodeJS.ProcessEnv;
}

describe("assertProductionEnv", () => {
  test("dev environment never throws, even with insecure defaults", () => {
    expect(() =>
      assertProductionEnv({
        NODE_ENV: "development",
        OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI: JWKS,
        OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER: ISSUER,
        // audience unset, secret is the dev default — fine in dev.
        OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET: DEV_CONTEXT_SECRET_DEFAULT,
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  test("test environment never throws", () => {
    expect(() =>
      assertProductionEnv({ NODE_ENV: "test" } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  test("production with a fully-configured env passes", () => {
    expect(() => assertProductionEnv(safeProdEnv())).not.toThrow();
  });

  test("production throws when bearer is configured but audience is unset", () => {
    const env = safeProdEnv();
    delete env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE;
    expect(() => assertProductionEnv(env)).toThrow(
      /OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE is unset/,
    );
  });

  test("production throws when the context secret is still the dev default", () => {
    const env = safeProdEnv();
    env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = DEV_CONTEXT_SECRET_DEFAULT;
    expect(() => assertProductionEnv(env)).toThrow(/still the public dev default/);
  });

  test("production throws when the context secret is unset", () => {
    const env = safeProdEnv();
    delete env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
    // Bearer is complete, so this is specifically the "secret unset" problem.
    expect(() => assertProductionEnv(env)).toThrow(
      /OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET is unset/,
    );
  });

  test("production throws when no complete auth method is configured", () => {
    // No bearer at all, and only the dev-default secret → both (b) and (c) fire.
    const env = {
      NODE_ENV: "production",
      OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET: DEV_CONTEXT_SECRET_DEFAULT,
    } as NodeJS.ProcessEnv;
    expect(() => assertProductionEnv(env)).toThrow(
      /No complete authentication method is configured/,
    );
  });

  test("production passes with only a non-default context secret (no bearer)", () => {
    // Bearer entirely absent is allowed as long as the context-secret path is
    // safe — that is a complete auth method on its own.
    const env = {
      NODE_ENV: "production",
      OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET: STRONG_SECRET,
    } as NodeJS.ProcessEnv;
    expect(() => assertProductionEnv(env)).not.toThrow();
  });

  test("production throws when the context secret is short and guessable", () => {
    // Non-default but weak (e.g. 'changeme123') must not pass just because it
    // clears the dev-default check — it is the sole trust proof for the
    // trusted-context path.
    const env = safeProdEnv();
    env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = "changeme123";
    expect(() => assertProductionEnv(env)).toThrow(
      /OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET is too short/,
    );
  });

  test("production throws when the context secret has too little variety", () => {
    // Long enough but almost no distinct characters — low entropy.
    const env = safeProdEnv();
    env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = "a".repeat(40);
    expect(() => assertProductionEnv(env)).toThrow(
      /OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET has too little variety/,
    );
  });

  test("context-secret minimum length is configurable via env", () => {
    // A 20-char secret passes the default 32 floor only when the operator
    // explicitly lowers the minimum.
    const twentyChars = "abcdefghij0123456789";
    const base = {
      NODE_ENV: "production",
      OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET: twentyChars,
    } as NodeJS.ProcessEnv;
    expect(() => assertProductionEnv(base)).toThrow(
      /OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET is too short/,
    );
    expect(() =>
      assertProductionEnv({
        ...base,
        OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET_MIN_LENGTH: "16",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});
