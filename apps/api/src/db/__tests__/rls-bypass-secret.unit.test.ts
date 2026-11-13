// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { DEV_CONTEXT_SECRET_DEFAULT } from "../../config/production-guard.js";
import {
  DEV_RLS_BYPASS_SECRET_DEFAULT,
  readRlsBypassSecret,
  rlsBypassToken,
  rlsBypassTokenDigest,
} from "../rls-bypass.js";

const strong = "kq3Zp9vX2mWc7Ls1TyNf8Rb4Hd6Ju0Ga5Ee";
const context = "c0ntext-Secret-9fK2mQ7xWv4Lr8Tz1Nb6";

describe("row-level-security bypass secret", () => {
  test("outside production the dedicated value or the local default is used, never the context secret", () => {
    expect(readRlsBypassSecret({})).toBe(DEV_RLS_BYPASS_SECRET_DEFAULT);
    expect(readRlsBypassSecret({ OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET: context })).toBe(DEV_RLS_BYPASS_SECRET_DEFAULT);
    expect(readRlsBypassSecret({ OPENSHAPEFORGE_RLS_BYPASS_SECRET: "short" })).toBe("short");
  });

  test("production refuses a missing, published or guessable secret", () => {
    const production = (env: Record<string, string>) => () => readRlsBypassSecret({ NODE_ENV: "production", ...env });
    expect(production({})).toThrow("is required in production");
    expect(production({ OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET: DEV_CONTEXT_SECRET_DEFAULT })).toThrow("is required in production");
    expect(production({ OPENSHAPEFORGE_RLS_BYPASS_SECRET: DEV_RLS_BYPASS_SECRET_DEFAULT })).toThrow("public dev default");
    expect(production({ OPENSHAPEFORGE_RLS_BYPASS_SECRET: "too-short" })).toThrow("at least 32 characters");
    expect(production({ OPENSHAPEFORGE_RLS_BYPASS_SECRET: "a".repeat(40) })).toThrow("distinct");
    expect(production({ OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET: "weak" })).toThrow("at least 32 characters");
  });

  test("production prefers the dedicated secret and otherwise derives one from the context secret", () => {
    expect(readRlsBypassSecret({ NODE_ENV: "production", OPENSHAPEFORGE_RLS_BYPASS_SECRET: strong, OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET: context })).toBe(strong);
    const derived = readRlsBypassSecret({ NODE_ENV: "production", OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET: context });
    expect(derived).toMatch(/^[0-9a-f]{64}$/);
    expect(derived).not.toContain(context);
    expect(readRlsBypassSecret({ NODE_ENV: "production", OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET: context })).toBe(derived);
  });

  test("the credential is a stable derivation that reveals neither the secret nor a reserved setting value", () => {
    const env = { NODE_ENV: "production", OPENSHAPEFORGE_RLS_BYPASS_SECRET: strong };
    const token = rlsBypassToken(env);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).toBe(rlsBypassToken({ ...env }));
    expect(token).not.toBe(rlsBypassToken({ NODE_ENV: "production", OPENSHAPEFORGE_RLS_BYPASS_SECRET: `${strong}x` }));
    expect(rlsBypassTokenDigest(env)).toMatch(/^[0-9a-f]{64}$/);
    expect(rlsBypassTokenDigest(env)).not.toBe(token);
  });
});
