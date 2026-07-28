// SPDX-License-Identifier: BUSL-1.1
/**
 * Pure unit tests for the API limits config readers. No server or database —
 * every case passes a fabricated env object, so these run fast and hermetically.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/config 2>&1
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  DEFAULT_TRUST_PROXY,
  readApiLimits,
  readNonNegativeIntEnv,
  readPositiveIntEnv,
  readStatementTimeoutMs,
  readTrustProxyEnv,
} from "../limits.js";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("readPositiveIntEnv", () => {
  test("returns the fallback when unset or blank", () => {
    expect(readPositiveIntEnv("X", 42, env({}))).toBe(42);
    expect(readPositiveIntEnv("X", 42, env({ X: "   " }))).toBe(42);
  });
  test("parses a valid positive integer", () => {
    expect(readPositiveIntEnv("X", 42, env({ X: "7" }))).toBe(7);
  });
  test("rejects zero, negatives, non-integers, and garbage", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "NaN"]) {
      expect(() => readPositiveIntEnv("X", 42, env({ X: bad }))).toThrow(/expected a positive integer/);
    }
  });
});

describe("readNonNegativeIntEnv", () => {
  test("returns the fallback when unset", () => {
    expect(readNonNegativeIntEnv("X", 15000, env({}))).toBe(15000);
  });
  test("allows zero (disabled) and positive integers", () => {
    expect(readNonNegativeIntEnv("X", 15000, env({ X: "0" }))).toBe(0);
    expect(readNonNegativeIntEnv("X", 15000, env({ X: "500" }))).toBe(500);
  });
  test("rejects negatives and non-integers", () => {
    for (const bad of ["-1", "1.5", "abc"]) {
      expect(() => readNonNegativeIntEnv("X", 15000, env({ X: bad }))).toThrow(
        /expected a non-negative integer/,
      );
    }
  });
});

describe("readTrustProxyEnv", () => {
  test("returns the fallback when unset", () => {
    expect(readTrustProxyEnv("X", 1, env({}))).toBe(1);
  });
  test("parses booleans, hop counts, and passes IP/CIDR lists through", () => {
    expect(readTrustProxyEnv("X", 1, env({ X: "true" }))).toBe(true);
    expect(readTrustProxyEnv("X", 1, env({ X: "false" }))).toBe(false);
    expect(readTrustProxyEnv("X", 1, env({ X: "2" }))).toBe(2);
    expect(readTrustProxyEnv("X", 1, env({ X: "10.0.0.0/8,127.0.0.1" }))).toBe(
      "10.0.0.0/8,127.0.0.1",
    );
  });
});

describe("readApiLimits", () => {
  test("uses safe defaults when nothing is set", () => {
    expect(readApiLimits(env({}))).toEqual({
      rateLimitMax: DEFAULT_RATE_LIMIT_MAX,
      rateLimitWindowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      trustProxy: DEFAULT_TRUST_PROXY,
    });
  });
  test("honours env overrides, including a disabled (0) request timeout", () => {
    expect(
      readApiLimits(
        env({
          API_RATE_LIMIT_MAX: "100",
          API_RATE_LIMIT_WINDOW_MS: "1000",
          API_REQUEST_TIMEOUT_MS: "0",
          API_TRUST_PROXY: "true",
        }),
      ),
    ).toEqual({
      rateLimitMax: 100,
      rateLimitWindowMs: 1000,
      requestTimeoutMs: 0,
      trustProxy: true,
    });
  });
});

describe("readStatementTimeoutMs", () => {
  test("defaults, overrides, and 0 (disabled)", () => {
    expect(readStatementTimeoutMs(env({}))).toBe(DEFAULT_STATEMENT_TIMEOUT_MS);
    expect(readStatementTimeoutMs(env({ DB_STATEMENT_TIMEOUT_MS: "5000" }))).toBe(5000);
    expect(readStatementTimeoutMs(env({ DB_STATEMENT_TIMEOUT_MS: "0" }))).toBe(0);
  });
});
