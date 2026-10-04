#!/usr/bin/env bun
// SPDX-License-Identifier: BUSL-1.1
/**
 * Runs the manifest-driven k6 performance suite against a running API and
 * renders a self-contained HTML report.
 *
 *   bun run test:perf                       # against http://127.0.0.1:3001
 *   API_URL=... PERF_VUS=10 PERF_DURATION=30s bun run test:perf
 *
 * Output: .perf-report/index.html (+ raw k6 summary.json). Exits with k6's
 * exit code, so threshold breaches fail the run while still producing the
 * report.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performanceVerdict, type PerfMetric, type PerfSummary } from "./perf-results.js";

const repoRoot = resolve(import.meta.dir, "..");
const reportDir = join(repoRoot, ".perf-report");
const summaryPath = join(reportDir, "summary.json");
const htmlPath = join(reportDir, "index.html");
const apiUrl = process.env.API_URL ?? "http://127.0.0.1:3001";
const catalogPath = join(reportDir, "fixture-catalog.json");

mkdirSync(reportDir, { recursive: true });

if (!process.env.PERF_TENANT_ID || !process.env.PERF_USER_ID) {
  console.error("PERF_TENANT_ID and PERF_USER_ID must name the isolated benchmark's seeded, linked identity.");
  process.exit(1);
}

if (!Bun.which("k6")) {
  console.error("k6 is not installed — `brew install k6` (https://k6.io) and retry.");
  process.exit(1);
}

try {
  const health = await fetch(`${apiUrl}/api/health`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!health.ok) throw new Error(`status ${health.status}`);
} catch (error) {
  console.error(
    `API is not reachable at ${apiUrl} (${String(error)}). Start it with \`bun run dev:api\`.`,
  );
  process.exit(1);
}

const startedAt = new Date();
const env = {
  ...process.env,
  API_URL: apiUrl,
  OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET:
    process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET ?? "openshapeforge-local-dev-context-secret",
  E2E_API_URL: apiUrl,
  PERF_CATALOG_PATH: catalogPath,
};

const preparation = Bun.spawnSync(["bun", "test", "apps/api/perf/prepare-fixtures.test.ts"],
  { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" });
writeFileSync(join(reportDir, "preflight.log"), `${preparation.stdout.toString()}\n${preparation.stderr.toString()}`);
if (preparation.exitCode !== 0) {
  console.error(`Canonical fixture preflight failed; k6 was not started. See ${reportDir}/preflight.log`);
  process.exit(preparation.exitCode ?? 1);
}
const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
  entities: Array<{ slug: string }>; exclusions: Array<{ entity: string; reason: string }>;
  preflightOperationCount: number;
  referencePolicyEvidence: Array<{ entity: string; successfulOperations: string[]; refusalCode: string; measuredOperationCount: number }>;
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

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

type TrendStats = PerfMetric;
let summary: PerfSummary | null = null;
try {
  summary = JSON.parse(readFileSync(summaryPath, "utf8")) as PerfSummary;
} catch {
  // k6 crashed before writing a summary — the report still shows the output.
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

type Row = {
  entity: string;
  op: string;
  stats: TrendStats;
  thresholdOk: boolean | null;
};
const rows: Row[] = [];
const verdict = performanceVerdict(summary, catalog.entities.map(entry => entry.slug), run.exitCode ?? 1);
const thresholdFailures = verdict.thresholdBreaches.length;

for (const [name, stats] of Object.entries(summary?.metrics ?? {})) {
  const match = /^http_req_duration\{entity:([^,}]+),op:([^}]+)\}$/.exec(name);
  if (!match) continue;
  // k6 --summary-export marks breached thresholds with `true`.
  const thresholdEntries = Object.values(stats.thresholds ?? {});
  const thresholdOk = thresholdEntries.length > 0 ? thresholdEntries.every((breached) => !breached) : null;
  rows.push({ entity: match[1]!, op: match[2]!, stats, thresholdOk });
}
rows.sort((a, b) => a.entity.localeCompare(b.entity) || a.op.localeCompare(b.op));

const format = (value: unknown) =>
  typeof value !== "number" ? "—" : `${value.toFixed(1)} ms`;

const entityCount = catalog.entities.length;
const failedRun = !verdict.passed;
const httpReqs = summary?.metrics["http_reqs"]?.count ?? 0;
const failedRate = summary?.metrics["http_req_failed"]?.value ?? 0;
const checksMetric = summary?.metrics["checks"];
const checksRate = checksMetric?.value;

const tableRows = rows
  .map(
    (row) => `
    <tr>
      <td>${row.thresholdOk === null ? "" : row.thresholdOk ? "✅" : "❌"}</td>
      <td>${escapeHtml(row.entity)}</td>
      <td>${escapeHtml(row.op)}</td>
      <td>${format(row.stats["avg"])}</td>
      <td>${format(row.stats["med"])}</td>
      <td>${format(row.stats["p(95)"])}</td>
      <td>${format(row.stats["p(99)"])}</td>
      <td>${format(row.stats["max"])}</td>
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
  td:nth-child(2), td:nth-child(3), th:nth-child(2), th:nth-child(3) { text-align: left; }
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
vus: ${process.env.PERF_VUS ?? 5}/entity · duration: ${process.env.PERF_DURATION ?? "15s"} ·
p95 budget: ${process.env.PERF_P95_MS ?? 800} ms ·
scenarios derived from apps/api/src/generated/db/manifest.json</p>
<p class="meta">${catalog.preflightOperationCount} real preflight operations · dependency fixtures prepared before timing ·
missing operation coverage: ${verdict.missingCoverage.length} · incomplete lifecycles: ${verdict.missingLifecycles.length} ·
anonymous/trusted rate budgets: ${escapeHtml(process.env.API_RATE_LIMIT_MAX ?? "API default")}/${escapeHtml(process.env.API_RATE_LIMIT_MAX_TRUSTED ?? "API default")}</p>
<p class="meta">Explicit exceptions: ${catalog.exclusions.map(item => `${escapeHtml(item.entity)} (${escapeHtml(item.reason)})`).join(", ") || "none"}</p>
<p class="meta">Untimed reference-policy evidence: ${catalog.referencePolicyEvidence.map(item =>
  `${escapeHtml(item.entity)}: ${item.successfulOperations.length} successful operations, delete ${escapeHtml(item.refusalCode)}, ${item.measuredOperationCount} latency metrics`).join("; ")}</p>
<table>
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

writeFileSync(htmlPath, html, "utf8");
console.log(
  `${failedRun ? "FAILED" : "passed"} — ${entityCount} entities, ${httpReqs} requests, ` +
    `${thresholdFailures} threshold breaches`,
);
console.log(`report: ${htmlPath}`);
writeFileSync(join(reportDir, "verdict.json"), JSON.stringify(verdict, null, 2) + "\n");
process.exit(run.exitCode || (verdict.passed ? 0 : 1));
