// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { providerReadExecutionFingerprint } from "../pinned-provider-read.js";

const target = {
  adapterKey: "sandbox-example",
  capabilityKey: "sync-page",
  origin: "https://provider.example",
  pathname: "/sync/page",
};
const service = { key: "read-page", version: 1, status: "published" };
const binding = { order: 1, optional: false, inputMapping: [{ from: "cursor", to: "since" }] };
const capability = {
  key: "sync-page", kind: "query",
  operation: { method: "GET", pathTemplate: "/sync/page?since={since}" },
};
const adapter = {
  key: "sandbox-example", transport: "rest", baseUrlTemplate: "https://provider.example",
};
const graph = { service, binding, capability, adapter };

test("the approved read digest binds all execution rows while ignoring storage timestamps", () => {
  const digest = providerReadExecutionFingerprint(target, graph);
  expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(providerReadExecutionFingerprint(target, {
    adapter, capability, binding, service: { ...service, updatedAt: "2099-01-01" },
  })).toBe(digest);

  for (const changed of [
    { ...graph, service: { ...service, version: 2 } },
    { ...graph, binding: { ...binding, inputMapping: [{ from: "other", to: "since" }] } },
    { ...graph, capability: { ...capability, responseMapping: { rootPath: "other" } } },
    { ...graph, adapter: { ...adapter, auth: { scheme: "bearer" } } },
  ]) {
    expect(providerReadExecutionFingerprint(target, changed)).not.toBe(digest);
  }
  expect(providerReadExecutionFingerprint({ ...target, pathname: "/sync/another" }, graph)).not.toBe(digest);
});

test("optional, repeated, mutating, and different provider bindings cannot be approved", () => {
  for (const changed of [
    { ...graph, binding: { ...binding, optional: true } },
    { ...graph, binding: { ...binding, forEach: { from: "items" } } },
    { ...graph, capability: { ...capability, operation: { method: "POST" } } },
    { ...graph, capability: { ...capability, pagination: {} } },
    { ...graph, adapter: { ...adapter, key: "other" } },
  ]) {
    expect(() => providerReadExecutionFingerprint(target, changed)).toThrow("approved provider read");
  }
});
