// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import type { CompiledEntityContract } from "./types.js";
import { compileProtectedFieldsFixture } from "./field-value-policy.fixtures.js";
import { buildWebManifest } from "./web-manifest.js";

test("web fields carry the same recursive protections and requiredness as the runtime", () => {
  let contract!: CompiledEntityContract;
  const manifest = compileProtectedFieldsFixture(candidate => { contract = candidate.contract; });
  // This fixture is authored for API tests; select the existing web list
  // projection without changing its compiled fields or their requiredness.
  const webContract = { ...contract, interfaces: { ...contract.interfaces, web: { operations: { list: true as const } } } };
  const web = buildWebManifest([{ slug: "protected-fields-fixture", contract: webContract }]);
  const fields = web.entities.ProtectedFieldsFixture!.fields;
  const columns = manifest.tables[0]!.columns;
  expect(fields.explicitSecret!.required).toBe(true);
  expect(fields.explicitSecret!.fieldPolicy).toEqual(columns.find(column => column.name === "explicit_secret")!.fieldPolicy);
  const { valueSchema: _schema, ...runtimePolicy } = columns.find(column => column.name === "data")!.fieldPolicy!;
  expect(fields.data!.fieldPolicy).toEqual(runtimePolicy);
  expect(fields.data!.children!.find(child => child.key === "restricted")).toMatchObject({
    required: true, fieldPolicy: { readRoles: ["Sensitive.Read"], writeRoles: ["Sensitive.Write"] },
  });
  expect(fields.data!.children!.find(child => child.key === "fixed")).toMatchObject({ required: true, fieldPolicy: { immutable: true } });
});
