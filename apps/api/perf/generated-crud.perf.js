// SPDX-License-Identifier: BUSL-1.1
/**
 * Manifest-driven k6 performance suite for the generated GraphQL CRUD API.
 *
 * Scenarios, request payloads, and thresholds are DERIVED at init time from
 * the generated db manifest — every `generatedCrud` entity gets its own
 * constant-VUs lifecycle scenario (create -> get -> list -> update -> delete,
 * with required FK dependencies created and cleaned per iteration). Adding a
 * new entity YAML and rerunning `bun run generate` extends the load test
 * automatically.
 *
 * Runs inside k6 (not bun/node): https://k6.io. Launch via
 * `bun run test:perf` (scripts/run-perf.ts), which supplies env, tenant, and
 * renders the HTML report.
 *
 * Env (all optional): API_URL, OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET,
 * PERF_TENANT_ID, PERF_USER_ID, PERF_VUS, PERF_DURATION, PERF_P95_MS.
 */
import http from "k6/http";
import crypto from "k6/crypto";
import { check } from "k6";
import { Counter } from "k6/metrics";

const API_URL = __ENV.API_URL || "http://127.0.0.1:3001";
const SECRET = __ENV.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET || "openshapeforge-local-dev-context-secret";
const TENANT_ID = __ENV.PERF_TENANT_ID || "99999999-9999-4999-8999-999999999999";
const USER_ID = __ENV.PERF_USER_ID || "88888888-8888-4888-8888-888888888888";
const VUS = Number(__ENV.PERF_VUS || 5);
const DURATION = __ENV.PERF_DURATION || "15s";
const P95_MS = Number(__ENV.PERF_P95_MS || 800);

const graphqlErrors = new Counter("graphql_errors");

// ---------------------------------------------------------------------------
// Manifest-driven derivation (mirrors the API engine's column rules)
// ---------------------------------------------------------------------------

const manifest = JSON.parse(open("../src/generated/db/manifest.json"));
const tables = manifest.tables.filter(
  (table) => table.generatedCrud && table.source && table.source.graphql,
);
const tablesByName = {};
for (const table of tables) {
  tablesByName[table.name] = table;
}

function fieldName(column) {
  return (
    column.sourceField ||
    column.name.replace(/_([a-z0-9])/g, (_match, char) => char.toUpperCase())
  );
}

function isMutableColumn(column) {
  return (
    !column.primaryKey &&
    column.generated !== "identity" &&
    column.name !== "tenant_id" &&
    column.name !== "created_at" &&
    column.name !== "updated_at"
  );
}

function foreignKeyTargets(table) {
  const emitted =
    (table.source.relationshipStatus && table.source.relationshipStatus.emittedReferences) || [];
  const map = {};
  for (const reference of emitted) {
    const match = /^(.+?)->(.+?)\.(.+?)\.(.+)$/.exec(reference);
    if (match) {
      map[match[1]] = `${match[2]}.${match[3]}`;
    }
  }
  return map;
}

function pseudoUuid() {
  return "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16),
  );
}

function sampleValue(column, marker) {
  switch (column.type) {
    case "text":
      return `perf-${marker}-${fieldName(column)}`;
    case "integer":
    case "bigint":
      return 7;
    case "numeric":
      return 7.5;
    case "boolean":
      return true;
    case "uuid":
      return pseudoUuid();
    case "date":
      return "2026-01-02";
    case "timestamptz":
      return "2026-01-02T03:04:05.000Z";
    case "jsonb":
      return {};
    default:
      return `perf-${marker}`;
  }
}

function textColumnFor(table) {
  return table.columns.find((column) => isMutableColumn(column) && column.type === "text");
}

// ---------------------------------------------------------------------------
// Trusted-context signing (mirrors @openshapeforge/auth applyTrustedContextHeaders)
// ---------------------------------------------------------------------------

// The generated CRUD layer enforces entity roles; sign and send the
// normalized ReadWrite role so perf sessions can exercise the full CRUD path.
const ROLES = "Relations.All.ReadWrite";

function signedHeaders() {
  const timestamp = String(Date.now());
  const payload = ["v2", timestamp, TENANT_ID, USER_ID, ROLES, ""].join("\n");
  return {
    "content-type": "application/json",
    "x-tenant-id": TENANT_ID,
    "x-user-id": USER_ID,
    "x-user-roles": ROLES,
    "x-openshapeforge-context-timestamp": timestamp,
    "x-openshapeforge-context-signature": crypto.hmac("sha256", SECRET, payload, "hex"),
  };
}

function gql(query, variables, tags) {
  const response = http.post(
    `${API_URL}/api/graphql`,
    JSON.stringify({ query, variables }),
    { headers: signedHeaders(), tags },
  );
  let body = null;
  try {
    body = JSON.parse(response.body);
  } catch (_error) {
    body = null;
  }
  const ok = check(
    response,
    {
      "status 200": (r) => r.status === 200,
      "no graphql errors": () => body !== null && !body.errors,
    },
    tags,
  );
  if (!ok) {
    graphqlErrors.add(1, tags);
  }
  return body && body.data ? body.data : null;
}

// ---------------------------------------------------------------------------
// Scenarios + thresholds, generated per entity
// ---------------------------------------------------------------------------

const OPS = ["create", "get", "list", "update", "delete"];
const scenarios = {};
const thresholds = {
  http_req_failed: ["rate<0.01"],
  checks: ["rate>0.99"],
};
for (const table of tables) {
  const slug = table.source.authoringEntitySlug;
  scenarios[slug] = {
    executor: "constant-vus",
    vus: VUS,
    duration: DURATION,
    exec: "lifecycle",
    env: { TABLE: table.name },
    tags: { entity: slug },
  };
  for (const op of OPS) {
    thresholds[`http_req_duration{entity:${slug},op:${op}}`] = [`p(95)<${P95_MS}`];
  }
}

export const options = {
  scenarios,
  thresholds,
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

// ---------------------------------------------------------------------------
// Per-iteration lifecycle: create (+ required FK deps) -> get -> list ->
// update -> delete (deps deleted in reverse). Self-cleaning per iteration.
// ---------------------------------------------------------------------------

function createRow(table, marker, depth) {
  if (depth > 5) {
    throw new Error(`FK dependency chain too deep while creating ${table.name}`);
  }
  const graphql = table.source.graphql;
  const slug = table.source.authoringEntitySlug;
  const fkTargets = foreignKeyTargets(table);
  const input = {};
  const dependencies = [];

  for (const column of table.columns) {
    if (!isMutableColumn(column)) continue;
    const target = fkTargets[column.name];
    if (target) {
      if (column.required) {
        const targetTable = tablesByName[target];
        const dependency = createRow(targetTable, marker, depth + 1);
        if (!dependency) return null;
        dependencies.push(...dependency.cleanup, {
          table: targetTable,
          id: dependency.id,
        });
        input[fieldName(column)] = dependency.id;
      }
      continue;
    }
    if (column.required) {
      input[fieldName(column)] = sampleValue(column, marker);
    }
  }

  const data = gql(
    `mutation($input: Create${graphql.typeName}Input!) {
       ${graphql.createMutationName}(input: $input) { id }
     }`,
    { input },
    { entity: slug, op: "create" },
  );
  const id = data && data[graphql.createMutationName] && data[graphql.createMutationName].id;
  if (!id) return null;
  return { id, cleanup: dependencies };
}

export function lifecycle() {
  const table = tablesByName[__ENV.TABLE];
  const graphql = table.source.graphql;
  const slug = table.source.authoringEntitySlug;
  const marker = `${__VU}-${__ITER}`;

  const created = createRow(table, marker, 0);
  if (!created) return;

  gql(
    `query($id: ID!) { ${graphql.singleQueryName}(id: $id) { id } }`,
    { id: created.id },
    { entity: slug, op: "get" },
  );

  gql(
    `query { ${graphql.listQueryName}(first: 25) { totalCount edges { node { id } } } }`,
    undefined,
    { entity: slug, op: "list" },
  );

  const updateColumn = textColumnFor(table);
  if (updateColumn) {
    gql(
      `mutation($input: Update${graphql.typeName}Input!) {
         ${graphql.updateMutationName}(input: $input) { id }
       }`,
      { input: { id: created.id, [fieldName(updateColumn)]: `perf-upd-${marker}` } },
      { entity: slug, op: "update" },
    );
  }

  gql(
    `mutation($id: ID!) { ${graphql.deleteMutationName}(id: $id) }`,
    { id: created.id },
    { entity: slug, op: "delete" },
  );
  for (const dependency of created.cleanup.reverse()) {
    const dependencyGraphql = dependency.table.source.graphql;
    gql(
      `mutation($id: ID!) { ${dependencyGraphql.deleteMutationName}(id: $id) }`,
      { id: dependency.id },
      { entity: dependency.table.source.authoringEntitySlug, op: "delete" },
    );
  }
}
