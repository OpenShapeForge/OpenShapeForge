// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import type { CompilerConditionInput } from "./canonical-condition.js";
import {
  evaluateAuthorizationSafeCondition,
  evaluateCanonicalCondition,
  isAuthorizationSafeConditionSatisfied,
  validateAuthorizationSafeCondition,
} from "./expression-evaluator.js";

const path = (p: string) => ({ kind: "path" as const, path: p });
const literal = (value: unknown) => ({ kind: "literal" as const, value });
const rule = (operator: string, left: unknown, right?: unknown) =>
  ({ operator, left, right } as unknown as CompilerConditionInput);

test("authorization conditions do not resolve inherited properties as actor or resource data", () => {
  const inheritedActor = Object.create({ department: "sales" });
  const condition = rule("equals", path("actorRelation.department"), literal("sales"));
  expect(evaluateCanonicalCondition(condition, { actorRelation: inheritedActor })).toBe(true);
  expect(evaluateAuthorizationSafeCondition(condition, { actorRelation: inheritedActor })).toMatchObject({
    outcome: "rejected", rejection: "unknownOperand",
  });
});

test("malformed conditions and excessive literal lists are refused", () => {
  expect(validateAuthorizationSafeCondition("invalid" as unknown as CompilerConditionInput).valid).toBe(false);
  expect(validateAuthorizationSafeCondition(rule("equals", 1, literal(1))).valid).toBe(false);
  expect(validateAuthorizationSafeCondition(rule("in", path("actorRelation.id"), literal(Array(101).fill("id")))).valid).toBe(false);
  expect(validateAuthorizationSafeCondition(rule("equals", path("actorRelation.id"), literal("a".repeat(2001)))).valid).toBe(false);
});

test("a negative operator over an operand the payload never carried is satisfied open-world and refused safe", () => {
  const notInDeniedDepartments = rule("notIn", path("actorRelation.department"), literal(["legal", "hr"]));
  const notEqualsOwner = rule("notEquals", path("resource.ownerId"), path("actorRelation.id"));
  const notContainsLabel = rule("notContains", path("resource.labels"), literal("secret"));
  const payload = { actorRelation: { id: "u1" }, resource: { id: "r1" } };

  // The open-world reading this subset exists to avoid.
  expect(evaluateCanonicalCondition(notInDeniedDepartments, payload)).toBe(true);
  expect(evaluateCanonicalCondition(notEqualsOwner, payload)).toBe(true);
  expect(evaluateCanonicalCondition(notContainsLabel, payload)).toBe(true);

  for (const condition of [notInDeniedDepartments, notEqualsOwner, notContainsLabel]) {
    expect(isAuthorizationSafeConditionSatisfied(condition, payload)).toBe(false);
    expect(evaluateAuthorizationSafeCondition(condition, payload)).toMatchObject({
      outcome: "rejected",
      rejection: "unknownOperand",
    });
  }
});

test("a null or non-finite operand is unresolved, not a value a negative operator can match", () => {
  const notEqualsOwner = rule("notEquals", path("resource.ownerId"), literal("u1"));
  expect(evaluateCanonicalCondition(notEqualsOwner, { resource: { ownerId: null } })).toBe(true);
  expect(
    evaluateAuthorizationSafeCondition(notEqualsOwner, { resource: { ownerId: null } }),
  ).toMatchObject({ outcome: "rejected", rejection: "unknownOperand" });
  expect(
    evaluateAuthorizationSafeCondition(rule("lessThan", path("actorRelation.level"), literal(3)), {
      actorRelation: { level: Number.NaN },
    }),
  ).toMatchObject({ outcome: "rejected", rejection: "unknownOperand" });
});

test("resolved operands decide in both directions, with the comparison table's semantics", () => {
  const payload = {
    actorRelation: { id: "u1", department: "sales", level: 4, tags: ["lead", "eu"] },
    resource: { ownerId: "u1", labels: ["public"], title: "Quote 2026" },
  };
  const satisfied: CompilerConditionInput[] = [
    rule("notIn", path("actorRelation.department"), literal(["legal", "hr"])),
    rule("equals", path("resource.ownerId"), path("actorRelation.id")),
    rule("in", path("actorRelation.department"), literal(["sales", "ops"])),
    rule("notContains", path("resource.labels"), literal("secret")),
    rule("contains", path("actorRelation.tags"), literal("lead")),
    rule("startsWith", path("resource.title"), literal("Quote")),
    rule("greaterThanOrEquals", path("actorRelation.level"), literal(4)),
  ];
  for (const condition of satisfied) {
    expect(evaluateAuthorizationSafeCondition(condition, payload)).toEqual({ outcome: "satisfied" });
  }
  const notSatisfied: CompilerConditionInput[] = [
    rule("in", path("actorRelation.department"), literal(["legal", "hr"])),
    rule("notEquals", path("resource.ownerId"), path("actorRelation.id")),
    rule("contains", path("resource.labels"), literal("secret")),
    rule("lessThan", path("actorRelation.level"), literal(4)),
  ];
  for (const condition of notSatisfied) {
    expect(evaluateAuthorizationSafeCondition(condition, payload)).toEqual({
      outcome: "notSatisfied",
    });
  }
});

test("an unknown branch does not sink an `any` group whose other branch is provably true", () => {
  const condition = {
    mode: "any" as const,
    conditions: [
      rule("equals", path("resource.ownerId"), path("actorRelation.id")),
      rule("notIn", path("actorRelation.department"), literal(["legal"])),
    ],
  } as unknown as CompilerConditionInput;

  // actorRelation.department is absent in both payloads: the OR is decided by the
  // branch that resolves, and unknown only when no branch is provably true.
  expect(
    evaluateAuthorizationSafeCondition(condition, {
      actorRelation: { id: "u1" },
      resource: { ownerId: "u1" },
    }),
  ).toEqual({ outcome: "satisfied" });
  expect(
    evaluateAuthorizationSafeCondition(condition, {
      actorRelation: { id: "u1" },
      resource: { ownerId: "u2" },
    }),
  ).toMatchObject({ outcome: "rejected", rejection: "unknownOperand" });
});

test("an unknown branch of an `all` group refuses, while a decided false branch answers", () => {
  const condition = {
    all: [
      rule("equals", path("resource.ownerId"), path("actorRelation.id")),
      rule("notIn", path("actorRelation.department"), literal(["legal"])),
    ],
  } as unknown as CompilerConditionInput;
  expect(
    evaluateAuthorizationSafeCondition(condition, {
      actorRelation: { id: "u1" },
      resource: { ownerId: "u1" },
    }),
  ).toMatchObject({ outcome: "rejected", rejection: "unknownOperand" });
  expect(
    evaluateAuthorizationSafeCondition(condition, {
      actorRelation: { id: "u1" },
      resource: { ownerId: "u2" },
    }),
  ).toEqual({ outcome: "notSatisfied" });
});

test("an operand pair the operator can only compare by coercion is unknown, not a match", () => {
  // `isEqual` reports different types as unequal, so `notEquals` would read a
  // string level against a numeric threshold as a match.
  expect(
    evaluateAuthorizationSafeCondition(rule("notEquals", path("actorRelation.level"), literal(4)), {
      actorRelation: { level: "4" },
    }),
  ).toMatchObject({ outcome: "rejected", rejection: "unsupportedOperand" });
  // `toNumber` turns unusable values into 0.
  expect(
    evaluateAuthorizationSafeCondition(rule("greaterThan", path("actorRelation.department"), literal(1)), {
      actorRelation: { department: "sales" },
    }),
  ).toMatchObject({ outcome: "rejected", rejection: "unsupportedOperand" });
  // A list of the wrong type can never hold the member, so `notIn` would match.
  expect(
    evaluateAuthorizationSafeCondition(rule("notIn", path("actorRelation.level"), literal(["4"])), {
      actorRelation: { level: 4 },
    }),
  ).toMatchObject({ outcome: "rejected", rejection: "unsupportedOperand" });
  // An empty list makes `notIn` vacuously true.
  expect(
    evaluateAuthorizationSafeCondition(rule("notIn", path("actorRelation.department"), path("resource.blocked")), {
      actorRelation: { department: "sales" },
      resource: { blocked: [] },
    }),
  ).toMatchObject({ outcome: "rejected", rejection: "unsupportedOperand" });
});

test("the accepted shape is checked before evaluation, and no refused shape can be satisfied", () => {
  const payload = { actorRelation: { id: "u1", department: "sales" }, resource: { ownerId: "u1" } };
  const cases: Array<[string, unknown, string]> = [
    ["an operator outside the subset", rule("isEmpty", path("actorRelation.department")), "unsupportedOperator"],
    ["a missing right operand", rule("notEquals", path("actorRelation.department")), "unsupportedOperand"],
    ["an operand kind that is not a value", rule("equals", path("actorRelation.id"), { kind: "date", op: "now" }), "unsupportedOperand"],
    ["a path outside the operand roots", rule("equals", path("session.id"), literal("u1")), "unsupportedOperand"],
    ["a filtered path", rule("equals", { kind: "path", path: "resource.lines", filter: { open: true } }, literal("u1")), "unsupportedOperand"],
    ["a null literal", rule("notEquals", path("resource.ownerId"), literal(null)), "unsupportedOperand"],
    ["an empty literal list", rule("notIn", path("actorRelation.department"), literal([])), "unsupportedOperand"],
    ["a top-level expression that is not a condition", path("actorRelation.id"), "unsupportedExpression"],
    ["a missing condition", undefined, "unsupportedExpression"],
    ["an empty group", { all: [] }, "unsupportedExpression"],
    ["a group declaring two child lists", { all: [rule("equals", path("actorRelation.id"), literal("u1"))], any: [] }, "unsupportedExpression"],
    ["a keyed group contradicted by mode", { any: [rule("equals", path("actorRelation.id"), literal("u1"))], mode: "all" }, "unsupportedExpression"],
  ];
  for (const [label, condition, rejection] of cases) {
    const input = condition as CompilerConditionInput;
    expect({ label, ...validateAuthorizationSafeCondition(input) }).toMatchObject({
      label,
      valid: false,
      rejection,
    });
    expect({ label, ...evaluateAuthorizationSafeCondition(input, payload) }).toMatchObject({
      label,
      outcome: "rejected",
      rejection,
    });
    expect(isAuthorizationSafeConditionSatisfied(input, payload)).toBe(false);
  }
});

test("complexity is bounded before evaluation, with a configurable ceiling", () => {
  const leaf = rule("equals", path("actorRelation.id"), literal("u1"));
  const nest = (depth: number): CompilerConditionInput => {
    let condition: unknown = leaf;
    for (let i = 0; i < depth; i++) condition = { all: [condition] };
    return condition as CompilerConditionInput;
  };
  expect(validateAuthorizationSafeCondition(nest(40))).toMatchObject({
    valid: false,
    rejection: "complexityExceeded",
  });
  expect(validateAuthorizationSafeCondition(nest(40), { maxDepth: 64 })).toEqual({ valid: true });

  const wide = { all: Array.from({ length: 150 }, () => leaf) } as unknown as CompilerConditionInput;
  expect(validateAuthorizationSafeCondition(wide)).toMatchObject({
    valid: false,
    rejection: "complexityExceeded",
  });
  expect(validateAuthorizationSafeCondition(wide, { maxNodes: 1000 })).toEqual({ valid: true });

  const deepPath = rule("equals", path("actorRelation.a.b.c.d.e.f.g.h.i"), literal("u1"));
  expect(validateAuthorizationSafeCondition(deepPath)).toMatchObject({
    valid: false,
    rejection: "complexityExceeded",
  });
  expect(validateAuthorizationSafeCondition(deepPath, { maxPathSegments: 32 })).toEqual({
    valid: true,
  });
});

test("the operand roots are configurable and still an allow-list", () => {
  const condition = rule("equals", path("tenant.id"), literal("t1"));
  expect(validateAuthorizationSafeCondition(condition)).toMatchObject({ valid: false });
  expect(
    evaluateAuthorizationSafeCondition(
      condition,
      { tenant: { id: "t1" } },
      { operandRoots: ["tenant"] },
    ),
  ).toEqual({ outcome: "satisfied" });
  // An empty or malformed allow-list falls back to the default rather than
  // accepting every root.
  expect(
    validateAuthorizationSafeCondition(condition, { operandRoots: [] }),
  ).toMatchObject({ valid: false, rejection: "unsupportedOperand" });
});

test("the open-world evaluator keeps its existing semantics", () => {
  const payload = {
    actorRelation: { id: "u1", level: 4, tags: ["lead"] },
    resource: { ownerId: "u1", title: "Quote 2026" },
    lines: [{ amount: 10 }, { amount: 32 }],
  };
  // Shapes the safe subset refuses, still evaluated as before.
  expect(evaluateCanonicalCondition(rule("isNotEmpty", path("resource.title")), payload)).toBe(true);
  expect(evaluateCanonicalCondition(rule("isEmpty", path("resource.absent")), payload)).toBe(true);
  expect(evaluateCanonicalCondition({ all: [] }, payload)).toBe(true);
  expect(
    evaluateCanonicalCondition(rule("greaterThan", path("actorRelation.level"), literal("3")), payload),
  ).toBe(true);
  expect(
    evaluateCanonicalCondition(
      rule(
        "equals",
        { kind: "aggregate", op: "sum", collection: "lines", of: path("amount") },
        literal(42),
      ),
      payload,
    ),
  ).toBe(true);
  expect(
    evaluateCanonicalCondition(
      {
        any: [
          rule("equals", path("actorRelation.id"), literal("nobody")),
          rule("contains", path("actorRelation.tags"), literal("lead")),
        ],
      },
      payload,
    ),
  ).toBe(true);
  expect(
    evaluateCanonicalCondition(rule("notEquals", path("resource.missing"), literal("x")), payload),
  ).toBe(true);
});
