// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { SCHEMA_PATTERN_MAX_LENGTH, schemaRegExp } from "./schema-regexp.js";

test("schema patterns keep search semantics, Unicode escapes and ordinary field constraints", () => {
  for (const [pattern, values] of [
    ["foo", ["prefix foo suffix", "no match"]],
    ["^[a-z][a-z0-9-]*$", ["sales-team", "1sales"]],
    ["^\\u00e9+$", ["éé", "ee"]],
    ["^(?:AB|CD)\\d{2}$", ["AB12", "xAB12"]],
  ] as const) {
    const re = schemaRegExp(pattern);
    for (const value of values) expect(re.test(value)).toBe(new RegExp(pattern, "u").test(value));
  }
});

test("nested quantifiers remain bounded for long failed matches", () => {
  const re = schemaRegExp("^(a+)+$");
  const start = performance.now();
  for (let i = 0; i < 10; i++) expect(re.test("a".repeat(50_000) + "!")).toBe(false);
  expect(performance.now() - start).toBeLessThan(1000);
});

test("unsupported or oversized patterns fail closed without exposing authored content", () => {
  for (const pattern of ["(?=secret)", "(secret)\\1", "a".repeat(SCHEMA_PATTERN_MAX_LENGTH + 1), "[invalid"]) {
    expect(() => schemaRegExp(pattern)).toThrow("Validation pattern is unsupported");
  }
});
