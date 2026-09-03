// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { RuntimeModule } from "../../modules/contract.js";
import { createApiReadinessChecks } from "../api-readiness.js";

describe("API readiness composition", () => {
  test("preserves core checks when modules contribute no readiness hooks", () => {
    const checks = createApiReadinessChecks(undefined, {
      loaded: [{ name: "no-hooks" }],
      failures: [],
    });

    expect(checks.map((check) => check.name)).toEqual([
      "database",
      "schema",
      "runtime_modules",
    ]);
  });

  test("appends module checks in deterministic name order", () => {
    const loaded: RuntimeModule[] = [{
      name: "second-module",
      readinessChecks: [{ name: "zeta", check: () => undefined }],
    }, {
      name: "first-module",
      readinessChecks: [{ name: "alpha", check: () => undefined }],
    }];

    const checks = createApiReadinessChecks(undefined, { loaded, failures: [] });

    expect(checks.map((check) => check.name)).toEqual([
      "database",
      "schema",
      "runtime_modules",
      "alpha",
      "zeta",
    ]);
  });
});
