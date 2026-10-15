// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { assertConfigurationOwner } from "../acting-relation-guard.js";
const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
test("credential rotation requires its existing owner, including same-tenant peers", () => {
  expect(() => assertConfigurationOwner({ relationId: owner }, owner, owner)).not.toThrow();
  expect(() => assertConfigurationOwner({ relationId: other }, owner, owner)).toThrow("does not match");
  expect(() => assertConfigurationOwner({}, owner, owner)).toThrow("not linked");
  expect(() => assertConfigurationOwner({}, null, null)).not.toThrow();
});

test("rotation cannot change a tenant credential into an unowned personal credential", () => {
  expect(() => assertConfigurationOwner({ relationId: owner }, null, owner)).toThrow("does not match");
  expect(() => assertConfigurationOwner({ relationId: owner }, owner, null)).toThrow("does not match");
});
