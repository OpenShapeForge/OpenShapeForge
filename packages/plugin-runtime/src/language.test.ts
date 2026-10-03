// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { actingRelationId } from "./acting-relation.js";
import { baseLanguage } from "./language.js";

test("a language tag reads as its base language, or null", () => {
  expect(baseLanguage("nl-NL")).toBe("nl");
  expect(baseLanguage("NL_nl")).toBe("nl");
  expect(baseLanguage(" en ")).toBe("en");
  expect(baseLanguage("")).toBeNull();
  expect(baseLanguage("not a tag!")).toBeNull();
  expect(baseLanguage(42)).toBeNull();
});

test("the acting Relation is the session's linked one, else null (#937)", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const replayed = "22222222-2222-4222-8222-222222222222";
  expect(actingRelationId({ relation: { status: "linked", relationId: id } })).toBe(id);
  expect(actingRelationId({ relation: { status: "linked", relationId: "not-a-uuid" } })).toBeNull();
  expect(actingRelationId({ relation: { status: "pending", relationId: id } })).toBeNull();
  expect(actingRelationId({ relation: null, relationId: replayed })).toBe(replayed);
  expect(actingRelationId({ relation: null })).toBeNull();
  expect(actingRelationId(undefined)).toBeNull();
});
