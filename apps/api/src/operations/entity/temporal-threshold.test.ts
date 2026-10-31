// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { evaluateTemporalThreshold } from "./temporal-threshold.js";

describe("temporal threshold", () => {
  const since = new Date("2026-01-01T00:00:00.000Z");
  const evaluate = (now: string, thresholdDays: number | null = 2) =>
    evaluateTemporalThreshold({ readable: true, applicable: true, since, thresholdDays, now: new Date(now) });

  test("uses elapsed 24-hour days and exceeds only after the threshold", () => {
    expect(evaluate("2026-01-03T00:00:00.000Z").status).toBe("within");
    expect(evaluate("2026-01-03T00:00:00.001Z").status).toBe("exceeded");
  });

  test("does not confuse unknown history with a negative result", () => {
    expect(evaluateTemporalThreshold({ readable: true, applicable: true, since: null, thresholdDays: 2, now: since }).status).toBe("unknown");
    expect(evaluate("2025-12-31T23:59:59.999Z").status).toBe("unknown");
  });

  test("treats a missing threshold or tracked value as not applicable", () => {
    expect(evaluate("2026-01-05T00:00:00.000Z", null).status).toBe("notApplicable");
    expect(evaluateTemporalThreshold({ readable: true, applicable: false, since: null, thresholdDays: 2, now: since }).status).toBe("notApplicable");
  });

  test("does not disclose threshold or applicability when a dependency is unreadable", () => {
    expect(evaluateTemporalThreshold({ readable: false, applicable: false, since, thresholdDays: 10, now: since })).toEqual({
      status: "unknown", since: null, thresholdDays: null,
    });
  });

  test("re-evaluates against the current threshold and clock", () => {
    expect(evaluate("2026-01-03T00:00:00.001Z", 3).status).toBe("within");
    expect(evaluate("2026-01-03T00:00:00.001Z", 2).status).toBe("exceeded");
    expect(evaluate("2026-01-01T00:00:00.001Z", 0).status).toBe("exceeded");
  });
});
