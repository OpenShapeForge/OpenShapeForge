#!/usr/bin/env bun
/**
 * Runs the manifest-driven GraphQL e2e suite and renders a human-readable,
 * self-contained HTML report.
 *
 *   bun run test:e2e:report            # in-process transport
 *   E2E_API_URL=... bun run test:e2e:report
 *
 * Output: .e2e-report/index.html (+ the raw junit.xml alongside). The script
 * exits with the test run's exit code, so it can gate CI while still always
 * producing the report.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const reportDir = join(repoRoot, ".e2e-report");
const junitPath = join(reportDir, "junit.xml");
const htmlPath = join(reportDir, "index.html");
const testFile = "src/graphql/__tests__";

mkdirSync(reportDir, { recursive: true });

const startedAt = new Date();
const run = Bun.spawnSync(
  ["bun", "test", testFile, "--reporter=junit", `--reporter-outfile=${junitPath}`],
  { cwd: join(repoRoot, "apps/api"), env: process.env, stdout: "pipe", stderr: "pipe" },
);
const consoleOutput = `${run.stdout.toString()}\n${run.stderr.toString()}`.trim();

// ---------------------------------------------------------------------------
// Minimal JUnit XML parsing (bun's output: nested <testsuite> per describe)
// ---------------------------------------------------------------------------

type Case = {
  name: string;
  suite: string;
  time: number;
  status: "pass" | "fail" | "skip";
  detail?: string;
};

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&");
}

function attr(tag: string, name: string): string {
  const match = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return match ? decodeEntities(match[1]!) : "";
}

function parseJunit(xml: string): Case[] {
  const cases: Case[] = [];
  const suiteStack: string[] = [];
  const tokens = xml.match(/<[^>]+>|[^<]+/g) ?? [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith("<testsuite ")) {
      suiteStack.push(attr(token, "name"));
    } else if (token.startsWith("</testsuite")) {
      suiteStack.pop();
    } else if (token.startsWith("<testcase ")) {
      const testCase: Case = {
        name: attr(token, "name"),
        // Skip the outer file-level suite; keep the describe chain.
        suite: suiteStack.slice(1).join(" › ") || suiteStack.join(" › "),
        time: Number(attr(token, "time") || 0),
        status: "pass",
      };
      if (!token.endsWith("/>")) {
        // Consume until </testcase>, catching <failure>/<skipped> children.
        let detail = "";
        for (i++; i < tokens.length && !tokens[i]!.startsWith("</testcase"); i++) {
          const child = tokens[i]!;
          if (child.startsWith("<failure") || child.startsWith("<error")) {
            testCase.status = "fail";
            detail += attr(child, "message");
          } else if (child.startsWith("<skipped")) {
            testCase.status = "skip";
          } else if (!child.startsWith("<")) {
            detail += decodeEntities(child);
          }
        }
        if (detail.trim()) testCase.detail = detail.trim();
      }
      cases.push(testCase);
    }
  }
  return cases;
}

let cases: Case[] = [];
let parseError: string | null = null;
try {
  cases = parseJunit(readFileSync(junitPath, "utf8"));
} catch (error) {
  parseError = String(error);
}

type CapturedRequest = {
  suite: string;
  test: string;
  auth: string;
  query: string;
  variables?: Record<string, unknown>;
  status: number;
  durationMs: number;
  response: unknown;
};
type CapturedEventRead = {
  suite: string;
  test: string;
  aggregateType: string;
  aggregateId: string;
  tenant: string;
  events: { eventType?: string; sequence?: string | number; payload?: unknown }[];
};
let capturedRequests: CapturedRequest[] = [];
let capturedEventReads: CapturedEventRead[] = [];
try {
  const capture = JSON.parse(readFileSync(join(reportDir, "requests.json"), "utf8")) as {
    requests: CapturedRequest[];
    eventReads?: CapturedEventRead[];
  };
  capturedRequests = capture.requests;
  capturedEventReads = capture.eventReads ?? [];
} catch {
  // Older suite without capture — the report simply omits request details.
}
const eventReadsByTest = new Map<string, CapturedEventRead[]>();
for (const read of capturedEventReads) {
  const key = `${read.suite}\u0000${read.test}`;
  const list = eventReadsByTest.get(key) ?? [];
  list.push(read);
  eventReadsByTest.set(key, list);
}

function renderEventReads(suite: string, testName: string): string {
  const reads = eventReadsByTest.get(`${suite}\u0000${testName}`) ?? [];
  if (reads.length === 0) return "";
  const entries = reads
    .map((read, index) => {
      const summaryTypes =
        read.events.length === 0
          ? "no events"
          : read.events.map((event) => event.eventType).join(", ");
      return `
      <details class="request">
        <summary>#${index + 1} · journal(${escapeHtml(read.aggregateType)} ${escapeHtml(
          read.aggregateId.slice(0, 8),
        )}…) as tenant ${escapeHtml(read.tenant)} → <b>${escapeHtml(summaryTypes)}</b></summary>
        <pre class="detail">${escapeHtml(renderJson(read.events))}</pre>
      </details>`;
    })
    .join("");
  return `
    <details class="requests">
      <summary>${reads.length} entity-event journal read${reads.length === 1 ? "" : "s"}
        (platform.entity_events)</summary>
      ${entries}
    </details>`;
}
const requestsByTest = new Map<string, CapturedRequest[]>();
for (const request of capturedRequests) {
  const key = `${request.suite}\u0000${request.test}`;
  const list = requestsByTest.get(key) ?? [];
  list.push(request);
  requestsByTest.set(key, list);
}

function renderJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2) ?? "undefined";
  return text.length > 3000 ? `${text.slice(0, 3000)}\n… (truncated)` : text;
}

function renderRequests(suite: string, testName: string): string {
  const requests = requestsByTest.get(`${suite}\u0000${testName}`) ?? [];
  if (requests.length === 0) return "";
  const entries = requests
    .map(
      (request, index) => `
      <details class="request">
        <summary>#${index + 1} · ${request.status} · ${request.durationMs} ms ·
          ${escapeHtml(request.auth)} · <code>${escapeHtml(request.query.slice(0, 90))}${
            request.query.length > 90 ? "…" : ""
          }</code></summary>
        <pre class="detail">query: ${escapeHtml(request.query)}${
          request.variables !== undefined
            ? `\n\nvariables: ${escapeHtml(renderJson(request.variables))}`
            : ""
        }\n\nresponse: ${escapeHtml(renderJson(request.response))}</pre>
      </details>`,
    )
    .join("");
  return `
    <details class="requests">
      <summary>${requests.length} GraphQL request${requests.length === 1 ? "" : "s"}</summary>
      ${entries}
    </details>`;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const passed = cases.filter((c) => c.status === "pass").length;
const failed = cases.filter((c) => c.status === "fail").length;
const skipped = cases.filter((c) => c.status === "skip").length;
const totalTime = cases.reduce((sum, c) => sum + c.time, 0);
const transport = process.env.E2E_API_URL
  ? `remote API (${process.env.E2E_API_URL})`
  : "in-process graphql-yoga";

const suites = new Map<string, Case[]>();
for (const testCase of cases) {
  const list = suites.get(testCase.suite) ?? [];
  list.push(testCase);
  suites.set(testCase.suite, list);
}

const badge = (status: Case["status"]) =>
  ({ pass: "✅", fail: "❌", skip: "⏭️" })[status];

const suiteSections = [...suites.entries()]
  .map(([suite, suiteCases]) => {
    const suiteFailed = suiteCases.some((c) => c.status === "fail");
    const rows = suiteCases
      .map(
        (c) => `
        <tr class="${c.status}">
          <td class="status">${badge(c.status)}</td>
          <td>${escapeHtml(c.name)}${
            c.detail ? `<pre class="detail">${escapeHtml(c.detail)}</pre>` : ""
          }${renderRequests(suite, c.name)}${renderEventReads(suite, c.name)}</td>
          <td class="time">${(c.time * 1000).toFixed(0)} ms</td>
        </tr>`,
      )
      .join("");
    return `
      <details ${suiteFailed ? "open" : ""}>
        <summary>${suiteFailed ? "❌" : "✅"} ${escapeHtml(suite)}
          <span class="count">${suiteCases.length} tests</span></summary>
        <table>${rows}</table>
      </details>`;
  })
  .join("");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>OpenShapeForge e2e report — ${failed > 0 ? "FAILED" : "passed"}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, "Segoe UI", sans-serif; max-width: 900px;
         margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.3rem; }
  .summary { display: flex; gap: 1rem; flex-wrap: wrap; margin: 1rem 0;
             padding: 1rem; border-radius: 8px;
             background: ${failed > 0 ? "#fdecea" : "#e8f5e9"}; }
  @media (prefers-color-scheme: dark) {
    .summary { background: ${failed > 0 ? "#4a1f1c" : "#1d3a22"}; } }
  .summary b { font-size: 1.2rem; display: block; }
  .meta { color: gray; font-size: 0.85rem; }
  details { border: 1px solid color-mix(in srgb, currentColor 15%, transparent);
            border-radius: 8px; margin: .6rem 0; padding: .3rem .8rem; }
  summary { cursor: pointer; font-weight: 600; padding: .3rem 0; }
  summary .count { color: gray; font-weight: 400; font-size: .85rem; margin-left: .5rem; }
  table { width: 100%; border-collapse: collapse; margin: .4rem 0; }
  td { padding: .3rem .5rem; border-top: 1px solid
       color-mix(in srgb, currentColor 10%, transparent); vertical-align: top; }
  td.status { width: 2rem; }
  td.time { width: 5rem; text-align: right; color: gray; }
  pre.detail { background: color-mix(in srgb, currentColor 8%, transparent);
               padding: .5rem; border-radius: 6px; overflow-x: auto;
               font-size: .8rem; white-space: pre-wrap; }
  details.requests { margin: .3rem 0; border: none; padding: 0 0 0 .4rem; }
  details.requests > summary { font-weight: 400; color: gray; font-size: .8rem; }
  details.request { border: none; padding: 0 0 0 .8rem; margin: .1rem 0; }
  details.request > summary { font-weight: 400; font-size: .8rem; }
  details.request code { font-size: .75rem; }
  pre.console { background: color-mix(in srgb, currentColor 8%, transparent);
                padding: .8rem; border-radius: 8px; overflow-x: auto;
                font-size: .8rem; }
</style>
</head>
<body>
<h1>OpenShapeForge GraphQL e2e report</h1>
<div class="summary">
  <div><b>${cases.length}</b> tests</div>
  <div><b>${passed}</b> passed</div>
  <div><b>${failed}</b> failed</div>
  <div><b>${skipped}</b> skipped</div>
  <div><b>${totalTime.toFixed(2)}s</b> test time</div>
</div>
<p class="meta">${startedAt.toISOString()} · transport: ${escapeHtml(transport)} ·
request log: .e2e-report/requests.json ·
suite derived from apps/api/src/generated/db/manifest.json
(${[...suites.keys()].filter((s) => s.includes("(erp.")).length} entities)</p>
${parseError ? `<pre class="detail">JUnit parse error: ${escapeHtml(parseError)}</pre>` : ""}
${suiteSections}
${(() => {
  const attributed = new Set(
    cases.map((c) => `${c.suite}\u0000${c.name}`),
  );
  const leftovers = capturedRequests.filter(
    (request) => !attributed.has(`${request.suite}\u0000${request.test}`),
  );
  if (leftovers.length === 0) return "";
  return `
    <details>
      <summary>Setup / cleanup requests (${leftovers.length})</summary>
      ${leftovers
        .map(
          (request) => `
        <pre class="detail">${escapeHtml(request.test)} · ${request.status} · ${
          request.durationMs
        } ms\n${escapeHtml(request.query)}\n${escapeHtml(renderJson(request.response))}</pre>`,
        )
        .join("")}
    </details>`;
})()}
<details>
  <summary>Runner console output</summary>
  <pre class="console">${escapeHtml(consoleOutput)}</pre>
</details>
</body>
</html>
`;

writeFileSync(htmlPath, html, "utf8");
console.log(
  `${failed > 0 ? "FAILED" : "passed"} — ${passed}/${cases.length} tests` +
    `${skipped ? ` (${skipped} skipped)` : ""}`,
);
console.log(`report: ${htmlPath}`);
process.exit(run.exitCode ?? 1);
