// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { buildWebRestOperationMap, type WebOperationOpenApi } from "./rest-operation-map.js";

const document: WebOperationOpenApi = { paths: {
  "/api/records/{id}": {
    parameters: [{ name: "id", in: "path", required: true }],
    get: { "x-osf-operation-id": "Record.get", parameters: [{ name: "fields", in: "query" }] },
    patch: { "x-osf-operation-id": "Record.update" },
  },
  "/health": { get: {} },
} };

test("projects authored Operation ids and transport parameters, not unrelated endpoints", () => {
  const map = buildWebRestOperationMap(document);
  expect(Object.keys(map)).toEqual(["Record.get", "Record.update"]);
  expect(map["Record.get"]).toEqual({ method: "GET", path: "/api/records/{id}", parameters: [
    { name: "id", in: "path", required: true }, { name: "fields", in: "query" },
  ] });
});

test("can limit projection to Operations used by the web manifest", () => {
  expect(Object.keys(buildWebRestOperationMap(document, ["Record.update"]))).toEqual(["Record.update"]);
  expect(buildWebRestOperationMap(document, [])).toEqual({});
});

test("operation parameters override shared parameters without duplicate query values", () => {
  expect(buildWebRestOperationMap({ paths: { "/records": {
    parameters: [{ name: "limit", in: "query", required: false }],
    get: { "x-osf-operation-id": "Record.list", parameters: [{ name: "limit", in: "query", required: true }] },
  } } })["Record.list"]?.parameters).toEqual([{ name: "limit", in: "query", required: true }]);
});
