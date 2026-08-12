// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  PERF_API_RATE_LIMIT_MAX_TRUSTED,
  assertPerfApiConfiguration,
  collectThresholdResults,
  renderPerfReport,
  type Summary,
} from "./run-perf";

function preflightResponse(limit?: string, remaining?: string, status = 200) {
  const headers = new Headers();
  if (limit !== undefined) headers.set("x-ratelimit-limit", limit);
  if (remaining !== undefined) headers.set("x-ratelimit-remaining", remaining);
  return { headers, ok: status >= 200 && status < 300, status };
}

describe("performance API preflight", () => {
  test("accepts only the dedicated trusted-caller budget", () => {
    expect(() =>
      assertPerfApiConfiguration(
        preflightResponse(
          String(PERF_API_RATE_LIMIT_MAX_TRUSTED),
          String(PERF_API_RATE_LIMIT_MAX_TRUSTED - 1),
        ),
      ),
    ).not.toThrow();
  });

  test("fails closed when the effective rate-limit header is absent", () => {
    expect(() => assertPerfApiConfiguration(preflightResponse())).toThrow(
      "omitted x-ratelimit-limit",
    );
  });

  test("fails closed when the running API uses another trusted budget", () => {
    expect(() => assertPerfApiConfiguration(preflightResponse("3000", "2999"))).toThrow(
      `expected ${PERF_API_RATE_LIMIT_MAX_TRUSTED}`,
    );
  });

  test("fails closed when the signed identity did not get a fresh allowance", () => {
    expect(() =>
      assertPerfApiConfiguration(
        preflightResponse(
          String(PERF_API_RATE_LIMIT_MAX_TRUSTED),
          String(PERF_API_RATE_LIMIT_MAX_TRUSTED - 2),
        ),
      ),
    ).toThrow("expected a fresh trusted allowance");
  });

  test("fails closed when the signed GraphQL probe is not healthy", () => {
    expect(() =>
      assertPerfApiConfiguration(
        preflightResponse(String(PERF_API_RATE_LIMIT_MAX_TRUSTED), undefined, 503),
      ),
    ).toThrow("status 503");
  });
});

describe("performance threshold report", () => {
  const summary: Summary = {
    metrics: {
      checks: {
        value: 0.12,
        thresholds: { "rate>0.99": true },
      },
      http_req_failed: {
        value: 0.88,
        thresholds: { "rate<0.01": true },
      },
      http_reqs: { count: 100 },
      "http_req_duration{entity:relation,op:create}": {
        avg: 20,
        med: 18,
        "p(95)": 40,
        "p(99)": 50,
        max: 60,
        thresholds: { "p(95)<800": false },
      },
    },
  };

  test("collects global and per-entity k6 thresholds", () => {
    expect(collectThresholdResults(summary)).toEqual([
      { metric: "checks", expression: "rate>0.99", breached: true },
      {
        metric: "http_req_duration{entity:relation,op:create}",
        expression: "p(95)<800",
        breached: false,
      },
      { metric: "http_req_failed", expression: "rate<0.01", breached: true },
    ]);
  });

  test("counts and displays breached global thresholds in the failed verdict", () => {
    const report = renderPerfReport({
      summary,
      consoleOutput: "thresholds on checks and http_req_failed have been crossed",
      runExitCode: 0,
      startedAt: new Date("2026-08-12T10:00:00.000Z"),
      apiUrl: "http://127.0.0.1:3001",
    });

    expect(report.failedRun).toBe(true);
    expect(report.thresholdFailures).toBe(2);
    expect(report.html).toContain("OpenShapeForge perf report — FAILED");
    expect(report.html).toContain("<b>2</b> threshold breaches");
    expect(report.html).toContain("Global thresholds");
    expect(report.html).toContain("checks");
    expect(report.html).toContain("http_req_failed");
    expect(report.html).toContain("rate&gt;0.99");
    expect(report.html).toContain("rate&lt;0.01");
  });
});
