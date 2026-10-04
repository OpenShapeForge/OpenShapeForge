// SPDX-License-Identifier: BUSL-1.1
/** Canonical lifecycle adapter; Bun prepares and proves its fixture catalog. */
import { Counter } from "k6/metrics";
import { catalog, gql, mutate } from "./transport.perf.js";

const OPS = ["create", "get", "list", "update", "delete"];
const completed = new Counter("lifecycle_completed");
const scenarios = {};
const thresholds = {
  http_req_failed: ["rate<0.01"],
  checks: ["rate>0.99"],
  canonical_errors: ["count==0"],
};
for (const entry of catalog.entities) {
  scenarios[entry.slug] = {
    executor: "constant-vus", vus: Number(__ENV.PERF_VUS || 5),
    duration: __ENV.PERF_DURATION || "15s", exec: "lifecycle",
    env: { TABLE: entry.table }, tags: { entity: entry.slug },
  };
  thresholds[`lifecycle_completed{entity:${entry.slug}}`] = ["count>0"];
  for (const op of OPS) {
    thresholds[`http_req_duration{entity:${entry.slug},op:${op}}`] = [`p(95)<${Number(__ENV.PERF_P95_MS || 800)}`];
    thresholds[`operation_success{entity:${entry.slug},op:${op}}`] = ["count>0"];
  }
}
export const options = { scenarios, thresholds,
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"] };

const byName = Object.fromEntries(catalog.entities.map(entry => [entry.table, entry]));
export function lifecycle() {
  const entry = byName[__ENV.TABLE];
  const metadata = entry.graphql;
  const input = JSON.parse(JSON.stringify(entry.createInput));
  if (entry.idempotencyField) input[entry.idempotencyField] = `perf-${__VU}-${__ITER}-${Date.now()}`;
  const created = gql(entry, "create", metadata.createMutationName,
    `mutation($input:${entry.createInputType}!){${metadata.createMutationName}(input:$input){data{id updatedAt}error{code}}}`,
    { input });
  if (!created) return;
  const current = gql(entry, "get", metadata.singleQueryName,
    `query($id:ID!){${metadata.singleQueryName}(id:$id){data{id updatedAt}error{code}}}`,
    { id: created.id });
  if (!current) return;
  const listed = gql(entry, "list", metadata.listQueryName,
    `query{${metadata.listQueryName}(first:25){data{items{data{id}}}error{code}}}`);
  if (!listed) return;
  const updated = mutate(entry, "update", current, { [entry.updateField]: entry.updateValue });
  if (!updated) return;
  if (!mutate(entry, "delete", updated)) return;
  completed.add(1, { entity: entry.slug });
}
