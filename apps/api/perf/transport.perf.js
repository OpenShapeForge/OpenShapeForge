// SPDX-License-Identifier: BUSL-1.1
import http from "k6/http";
import crypto from "k6/crypto";
import { check } from "k6";
import { Counter } from "k6/metrics";
import { operationOutcome } from "./result-policy.js";

export const catalog = JSON.parse(open("../../../.perf-report/fixture-catalog.json"));
const API_URL = __ENV.API_URL || "http://127.0.0.1:3001";
const SECRET = __ENV.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET || "openshapeforge-local-dev-context-secret";
const roles = catalog.roles.join(",");
const errors = new Counter("canonical_errors");
const successes = new Counter("operation_success");

function headers() {
  const timestamp = String(Date.now());
  return {
    "content-type": "application/json", "x-tenant-id": catalog.tenantId,
    "x-user-id": catalog.userId, "x-user-roles": roles,
    "x-openshapeforge-context-timestamp": timestamp,
    "x-openshapeforge-context-signature": crypto.hmac("sha256", SECRET,
      ["v2", timestamp, catalog.tenantId, catalog.userId, roles, ""].join("\n"), "hex"),
  };
}
function json(response) {
  try { return JSON.parse(response.body); } catch (_) { return null; }
}
function fail(tags) { errors.add(1, tags); return null; }
function operationRequest(entry, op, field, query, variables, expectedChallenge) {
  const tags = { entity: entry.slug, op };
  errors.add(0, tags);
  const response = http.post(`${API_URL}/api/graphql`, JSON.stringify({ query, variables }), { headers: headers(), tags });
  const outcome = operationOutcome(response.status, json(response), field, op, expectedChallenge);
  if (!check(outcome, { "canonical result accepted": value => value.ok }, tags)) return fail(tags);
  if (!expectedChallenge) successes.add(1, tags);
  return expectedChallenge ? outcome.challengeToken : outcome.data;
}
export function gql(entry, op, field, query, variables) {
  return operationRequest(entry, op, field, query, variables, false);
}
function rest(entry, path, body, expectedStatus) {
  const tags = { entity: entry.slug, op: "control" };
  const response = http.post(`${API_URL}${path}`, JSON.stringify(body), { headers: headers(), tags });
  const parsed = json(response);
  if (!check(response, { "canonical lease status": value => value.status === expectedStatus && !!parsed?.data && !parsed.error }, tags)) return fail(tags);
  return parsed.data;
}
export function mutate(entry, intent, row, values = {}) {
  const policy = entry.controls[intent];
  const controls = {};
  if (policy.concurrency?.version) controls.expectedVersion = row[policy.concurrency.version.field];
  let leaseToken;
  if (policy.concurrency?.editLease) {
    const lease = rest(entry, "/api/operation-leases", { operationId: `${entry.entity}.${intent}`, targetId: row.id }, 201);
    if (!lease || typeof lease.targetVersion !== "string" || typeof lease.leaseToken !== "string") return fail({ entity: entry.slug, op: "control" });
    controls.expectedVersion = lease.targetVersion;
    controls.leaseToken = leaseToken = lease.leaseToken;
  }
  const field = entry.graphql[intent === "update" ? "updateMutationName" : "deleteMutationName"];
  const inputType = `${intent === "update" ? "Update" : "Delete"}${entry.graphql.typeName}Input`;
  const selection = intent === "delete" ? "deleted" : "id updatedAt";
  const query = `mutation($input:${inputType}!){${field}(input:$input){data{${selection}}error{code data}}}`;
  try {
    if (policy.confirmation.mode === "acknowledgement") controls.confirmed = true;
    if (policy.confirmation.mode === "challenge") {
      const token = operationRequest(entry, "confirmation", field, query, { input: { id: row.id, ...values, ...controls } }, true);
      if (!token) return null;
      const challengeField = policy.confirmation.challenge.field;
      const relation = entry.graphql.relationships?.some(r => r.fieldKey === challengeField);
      const current = gql(entry, "control", entry.graphql.singleQueryName,
        `query($id:ID!){${entry.graphql.singleQueryName}(id:$id){data{id ${challengeField}${relation ? "{id}" : ""}}error{code}}}`, { id: row.id });
      if (!current || current[challengeField] == null || current[challengeField] === "") return fail({ entity: entry.slug, op: "control" });
      const value = current[challengeField];
      controls.confirmationToken = token;
      controls.confirmationAnswer = String(typeof value === "object" ? value.id : value);
    }
    return gql(entry, intent, field, query, { input: { id: row.id, ...values, ...controls } });
  } finally {
    if (leaseToken) rest(entry, "/api/operation-leases/release", { leaseToken }, 200);
  }
}
