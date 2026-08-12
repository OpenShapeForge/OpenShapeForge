#!/usr/bin/env bun
// SPDX-License-Identifier: BUSL-1.1
/**
 * Runs the manifest-driven k6 performance suite against a running API and
 * renders a self-contained HTML report.
 *
 *   API_RATE_LIMIT_MAX_TRUSTED=1000000 bun run dev:api  # dedicated API process
 *   bun run test:perf                                   # separate terminal
 *
 * Output: .perf-report/index.html (+ raw k6 summary.json). Exits non-zero when
 * k6 or a threshold fails, while still producing the report.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyTrustedContextHeaders } from "../packages/auth/src/index.ts";

export const PERF_API_RATE_LIMIT_MAX_TRUSTED = 1_000_000;

const RATE_LIMIT_HEADER = "x-ratelimit-limit";
const RATE_LIMIT_REMAINING_HEADER = "x-ratelimit-remaining";
const ENTITY_DURATION_METRIC = /^http_req_duration\{entity:([^,}]+),op:([^}]+)\}$/;

export type TrendStats = {
  [name: string]: number | Record<string, boolean> | undefined;
  thresholds?: Record<string, boolean>;
};

export type Summary = {
  metrics: Record<string, TrendStats>;
};

export type ThresholdResult = {
  metric: string;
  expression: string;
  breached: boolean;
};

type Row = {
  entity: string;
  op: string;
  stats: TrendStats;
  thresholdOk: boolean | null;
};

export type PerfReport = {
  html: string;
  entityCount: number;
  httpReqs: number;
  thresholdFailures: number;
  failedRun: boolean;
};

export function collectThresholdResults(summary: Summary | null): ThresholdResult[] {
  const results: ThresholdResult[] = [];
  for (const [metric, stats] of Object.entries(summary?.metrics ?? {})) {
    for (const [expression, breached] of Object.entries(stats.thresholds ?? {})) {
      results.push({ metric, expression, breached });
    }
  }
  return results.sort(
    (left, right) =>
      left.metric.localeCompare(right.metric) || left.expression.localeCompare(right.expression),
  );
}

/**
 * The perf suite must see the dedicated trusted-caller budget and a fresh
 * allowance on the effective API response. The preflight calls this for two
 * distinct signed identities; both must get their own fresh allowance, proving
 * the running API classified them in the expected trusted tier.
 */
export function assertPerfApiConfiguration(
  response: Pick<Response, "headers" | "ok" | "status">,
  expectedTrustedLimit = PERF_API_RATE_LIMIT_MAX_TRUSTED,
): void {
  if (!response.ok) {
    throw new Error(`signed GraphQL preflight returned status ${response.status}`);
  }

  const rawLimit = response.headers.get(RATE_LIMIT_HEADER);
  if (rawLimit === null) {
    throw new Error(`signed GraphQL preflight omitted ${RATE_LIMIT_HEADER}`);
  }
  const rawRemaining = response.headers.get(RATE_LIMIT_REMAINING_HEADER);
  if (rawRemaining === null) {
    throw new Error(`signed GraphQL preflight omitted ${RATE_LIMIT_REMAINING_HEADER}`);
  }

  const actualLimit = Number(rawLimit);
  if (!Number.isSafeInteger(actualLimit) || actualLimit !== expectedTrustedLimit) {
    throw new Error(
      `signed GraphQL preflight reported ${RATE_LIMIT_HEADER}=${rawLimit}; ` +
        `expected ${expectedTrustedLimit}`,
    );
  }
  const actualRemaining = Number(rawRemaining);
  const expectedRemaining = expectedTrustedLimit - 1;
  if (!Number.isSafeInteger(actualRemaining) || actualRemaining !== expectedRemaining) {
    throw new Error(
      `signed GraphQL preflight reported ${RATE_LIMIT_REMAINING_HEADER}=${rawRemaining}; ` +
        `expected a fresh trusted allowance of ${expectedRemaining}`,
    );
  }
}

async function preflightPerfApi(apiUrl: string, contextSecret: string): Promise<void> {
  for (let probe = 0; probe < 2; probe += 1) {
    const headers = new Headers({ "content-type": "application/json" });
    applyTrustedContextHeaders(
      headers,
      {
        tenantId: randomUUID(),
        userId: randomUUID(),
        roles: [],
        groups: [],
      },
      { secret: contextSecret },
    );

    let response: Response;
    try {
      response = await fetch(`${apiUrl}/api/graphql`, {
        method: "POST",
        headers,
        body: JSON.stringify({ query: "query PerfPreflight { __typename }" }),
        signal: AbortSignal.timeout(3000),
      });
    } catch (error) {
      throw new Error(`API is not reachable at ${apiUrl} (${String(error)})`);
    }
    assertPerfApiConfiguration(response);
  }
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const formatDuration = (value: number | undefined) =>
  value === undefined ? "—" : `${value.toFixed(1)} ms`;

function numericStat(stats: TrendStats | undefined, name: string): number | undefined {
  const value = stats?.[name];
  return typeof value === "number" ? value : undefined;
}

function thresholdOk(stats: TrendStats): boolean | null {
  const thresholdEntries = Object.values(stats.thresholds ?? {});
  return thresholdEntries.length > 0
    ? thresholdEntries.every((breached) => !breached)
    : null;
}

function formatGlobalValue(metric: string, stats: TrendStats | undefined): string {
  const value = numericStat(stats, "value");
  if (value === undefined) return "—";
  if (metric === "checks" || metric === "http_req_failed") {
    return `${(value * 100).toFixed(2)}%`;
  }
  return String(value);
}

export function renderPerfReport(options: {
  summary: Summary | null;
  consoleOutput: string;
  runExitCode: number;
  startedAt: Date;
  apiUrl: string;
  perfVus?: string;
  perfDuration?: string;
  perfP95Ms?: string;
}): PerfReport {
  const {
    summary,
    consoleOutput,
    runExitCode,
    startedAt,
    apiUrl,
    perfVus,
    perfDuration,
    perfP95Ms,
  } = options;
  const rows: Row[] = [];

  for (const [name, stats] of Object.entries(summary?.metrics ?? {})) {
    const match = ENTITY_DURATION_METRIC.exec(name);
    if (!match) continue;
    rows.push({
      entity: match[1]!,
      op: match[2]!,
      stats,
      thresholdOk: thresholdOk(stats),
    });
  }
  rows.sort((left, right) => left.entity.localeCompare(right.entity) || left.op.localeCompare(right.op));

  const thresholds = collectThresholdResults(summary);
  const globalThresholds = thresholds.filter(
    ({ metric }) => !ENTITY_DURATION_METRIC.test(metric),
  );
  const thresholdFailures = thresholds.filter(({ breached }) => breached).length;
  const entityCount = new Set(rows.map((row) => row.entity)).size;
  const httpReqs = numericStat(summary?.metrics["http_reqs"], "count") ?? 0;
  const failedRate = numericStat(summary?.metrics["http_req_failed"], "value") ?? 0;
  const checksRate = numericStat(summary?.metrics["checks"], "value");
  const failedRun = runExitCode !== 0 || thresholdFailures > 0;

  const globalThresholdRows = globalThresholds.length
    ? globalThresholds
        .map(
          (result) => `
    <tr>
      <td>${result.breached ? "❌" : "✅"}</td>
      <td>${escapeHtml(result.metric)}</td>
      <td><code>${escapeHtml(result.expression)}</code></td>
      <td>${formatGlobalValue(result.metric, summary?.metrics[result.metric])}</td>
    </tr>`,
        )
        .join("")
    : '<tr><td colspan="4">No global threshold data was written.</td></tr>';

  const tableRows = rows
    .map(
      (row) => `
    <tr>
      <td>${row.thresholdOk === null ? "" : row.thresholdOk ? "✅" : "❌"}</td>
      <td>${escapeHtml(row.entity)}</td>
      <td>${escapeHtml(row.op)}</td>
      <td>${formatDuration(numericStat(row.stats, "avg"))}</td>
      <td>${formatDuration(numericStat(row.stats, "med"))}</td>
      <td>${formatDuration(numericStat(row.stats, "p(95)"))}</td>
      <td>${formatDuration(numericStat(row.stats, "p(99)"))}</td>
      <td>${formatDuration(numericStat(row.stats, "max"))}</td>
    </tr>`,
    )
    .join("");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>OpenShapeForge perf report — ${failedRun ? "FAILED" : "passed"}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, "Segoe UI", sans-serif; max-width: 900px;
         margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.3rem; }
  h2 { font-size: 1.05rem; margin-top: 1.5rem; }
  .summary { display: flex; gap: 1.2rem; flex-wrap: wrap; margin: 1rem 0;
             padding: 1rem; border-radius: 8px;
             background: ${failedRun ? "#fdecea" : "#e8f5e9"}; }
  @media (prefers-color-scheme: dark) {
    .summary { background: ${failedRun ? "#4a1f1c" : "#1d3a22"}; } }
  .summary b { font-size: 1.2rem; display: block; }
  .meta { color: gray; font-size: 0.85rem; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
  th, td { padding: .35rem .6rem; text-align: right;
           border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent); }
  th { font-size: .8rem; text-transform: uppercase; color: gray; }
  .global-thresholds td:nth-child(2), .global-thresholds td:nth-child(3),
  .global-thresholds th:nth-child(2), .global-thresholds th:nth-child(3),
  .latency td:nth-child(2), .latency td:nth-child(3),
  .latency th:nth-child(2), .latency th:nth-child(3) { text-align: left; }
  pre.console { background: color-mix(in srgb, currentColor 8%, transparent);
                padding: .8rem; border-radius: 8px; overflow-x: auto; font-size: .8rem; }
</style>
</head>
<body>
<h1>OpenShapeForge GraphQL performance report (k6)</h1>
<div class="summary">
  <div><b>${entityCount}</b> entities</div>
  <div><b>${httpReqs}</b> requests</div>
  <div><b>${(failedRate * 100).toFixed(2)}%</b> http failures</div>
  <div><b>${checksRate === undefined ? "—" : `${(checksRate * 100).toFixed(2)}%`}</b> checks passed</div>
  <div><b>${thresholdFailures}</b> threshold breaches</div>
</div>
<p class="meta">${startedAt.toISOString()} · target: ${escapeHtml(apiUrl)} ·
vus: ${perfVus ?? 5}/entity · duration: ${perfDuration ?? "15s"} ·
p95 budget: ${perfP95Ms ?? 800} ms ·
scenarios derived from apps/api/src/generated/db/manifest.json</p>
<h2>Global thresholds</h2>
<table class="global-thresholds">
  <tr><th></th><th>metric</th><th>threshold</th><th>actual</th></tr>
  ${globalThresholdRows}
</table>
<h2>Entity latency thresholds</h2>
<table class="latency">
  <tr><th></th><th>entity</th><th>op</th><th>avg</th><th>med</th><th>p95</th><th>p99</th><th>max</th></tr>
  ${tableRows}
</table>
<details>
  <summary>k6 output</summary>
  <pre class="console">${escapeHtml(consoleOutput)}</pre>
</details>
</body>
</html>
`;

  return { html, entityCount, httpReqs, thresholdFailures, failedRun };
}

export async function runPerf(): Promise<number> {
  const repoRoot = resolve(import.meta.dir, "..");
  const reportDir = join(repoRoot, ".perf-report");
  const summaryPath = join(reportDir, "summary.json");
  const htmlPath = join(reportDir, "index.html");
  const apiUrl = process.env.API_URL ?? "http://127.0.0.1:3001";
  const contextSecret =
    process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET ??
    "openshapeforge-local-dev-context-secret";

  mkdirSync(reportDir, { recursive: true });

  if (!Bun.which("k6")) {
    console.error("k6 is not installed — `brew install k6` (https://k6.io) and retry.");
    return 1;
  }

  try {
    await preflightPerfApi(apiUrl, contextSecret);
  } catch (error) {
    console.error(`Performance API preflight failed: ${String(error)}`);
    const startCommand =
      `API_RATE_LIMIT_MAX_TRUSTED=${PERF_API_RATE_LIMIT_MAX_TRUSTED} bun run dev:api`;
    console.error(
      `Restart the dedicated API with \`${startCommand}\`, then retry.`,
    );
    return 1;
  }

  const startedAt = new Date();
  const env = {
    ...process.env,
    API_URL: apiUrl,
    OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET: contextSecret,
    // Fresh tenant per run: RLS-isolated from dev data; lifecycle iterations
    // clean their own rows, only entity_events journal rows accumulate.
    PERF_TENANT_ID: process.env.PERF_TENANT_ID ?? randomUUID(),
    PERF_USER_ID: process.env.PERF_USER_ID ?? randomUUID(),
  };

  const run = Bun.spawnSync(
    [
      "k6",
      "run",
      "apps/api/perf/generated-crud.perf.js",
      `--summary-export=${summaryPath}`,
      "--quiet",
    ],
    { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" },
  );
  const consoleOutput = `${run.stdout.toString()}\n${run.stderr.toString()}`.trim();

  let summary: Summary | null = null;
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8")) as Summary;
  } catch {
    // k6 crashed before writing a summary — the report still shows the output.
  }

  const report = renderPerfReport({
    summary,
    consoleOutput,
    runExitCode: run.exitCode ?? 1,
    startedAt,
    apiUrl,
    ...(process.env.PERF_VUS ? { perfVus: process.env.PERF_VUS } : {}),
    ...(process.env.PERF_DURATION ? { perfDuration: process.env.PERF_DURATION } : {}),
    ...(process.env.PERF_P95_MS ? { perfP95Ms: process.env.PERF_P95_MS } : {}),
  });

  writeFileSync(htmlPath, report.html, "utf8");
  console.log(
    `${report.failedRun ? "FAILED" : "passed"} — ${report.entityCount} entities, ` +
      `${report.httpReqs} requests, ${report.thresholdFailures} threshold breaches`,
  );
  console.log(`report: ${htmlPath}`);
  return report.failedRun ? run.exitCode || 1 : 0;
}

if (import.meta.main) {
  process.exit(await runPerf());
}
