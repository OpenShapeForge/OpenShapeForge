// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { documentLifecycleException, operationOutcome } from "../apps/api/perf/result-policy.js";
import { PERF_OPERATIONS, performanceVerdict, type PerfSummary } from "./perf-results.js";

test("HTTP success cannot mask canonical refusals, missing data or wrong delete outcome", () => {
  for (const body of [null, { errors: [{ message: "refused" }] }, { data: { result: { error: { code: "VALIDATION" } } } }, { data: { result: { data: null } } }]) {
    expect(operationOutcome(200, body, "result", "create").ok).toBe(false);
  }
  expect(operationOutcome(503, { data: { result: { data: { id: "valid" } } } }, "result", "get").ok).toBe(false);
  expect(operationOutcome(200, { data: { result: { data: { deleted: false } } } }, "result", "delete").ok).toBe(false);
  expect(operationOutcome(200, { data: { result: { data: { items: [] } } } }, "result", "list").ok).toBe(false);
});
test("only an explicit typed challenge is an expected control exchange", () => {
  const body = { data: { result: { error: { code: "CONFIRMATION_REQUIRED", data: { confirmation: { challengeToken: "fixture-token" } } } } } };
  expect(operationOutcome(200, body, "result", "confirmation", true).ok).toBe(true);
  expect(operationOutcome(200, body, "result", "delete").ok).toBe(false);
  expect(operationOutcome(200, { data: { result: { error: { code: "CONFIRMATION_REQUIRED" } } } }, "result", "confirmation", true).ok).toBe(false);
});
test("only the proven Document companion policy is a lifecycle exception", () => {
  const refs = ["erp.document_versions.document_id"];
  const policy = { update: false, delete: false };
  expect(documentLifecycleException("Document", refs, policy)).toBe(true);
  expect(documentLifecycleException("AgreementMilestone", refs, policy)).toBe(false);
  expect(documentLifecycleException("Document", [], policy)).toBe(false);
  expect(documentLifecycleException("Document", [...refs, "erp.other.document_id"], policy)).toBe(false);
  expect(documentLifecycleException("Document", refs, { update: false, delete: true })).toBe(false);
  expect(operationOutcome(200, { data: { result: { error: { code: "REFERENCE_IN_USE" } } } }, "result", "delete").ok).toBe(false);
});
test("all global threshold failures and absent successful operations fail the report", () => {
  const metrics: PerfSummary["metrics"] = Object.fromEntries(PERF_OPERATIONS.map(op => [`operation_success{entity:sample,op:${op}}`, { count: 1 }]));
  metrics["lifecycle_completed{entity:sample}"] = { count: 1 };
  expect(performanceVerdict({ metrics }, ["sample"], 0).passed).toBe(true);
  metrics.checks = { thresholds: { "rate>0.99": true } };
  const globalFailure = performanceVerdict({ metrics }, ["sample"], 0);
  expect(globalFailure.passed).toBe(false);
  expect(globalFailure.thresholdBreaches).toEqual([{ metric: "checks", threshold: "rate>0.99" }]);
  delete metrics.checks;
  metrics["lifecycle_completed{entity:sample}"] = { count: 0 };
  expect(performanceVerdict({ metrics }, ["sample"], 0).missingLifecycles).toEqual(["sample"]);
  expect(performanceVerdict({ metrics }, ["sample"], 0).passed).toBe(false);
  metrics["lifecycle_completed{entity:sample}"] = { count: 1 };
  delete metrics["operation_success{entity:sample,op:delete}"];
  expect(performanceVerdict({ metrics }, ["sample"], 0).missingCoverage).toEqual([{ entity: "sample", op: "delete" }]);
  expect(performanceVerdict({ metrics }, ["sample"], 0).passed).toBe(false);
  expect(performanceVerdict(null, ["sample"], 0).passed).toBe(false);
  expect(performanceVerdict({ metrics }, ["sample"], 99).passed).toBe(false);
});
