// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  assertVariableCompatible,
  assertVariableSourceValue,
  compatibleVariableOffers,
  fieldVariableSlot,
  matchesBaseType,
  parseVariableReference,
  variableCompatibility,
  variableOffer,
  variableOffers,
  variableText,
  VariableError,
  VARIABLE_NAMESPACE_SCOPES,
  wholeVariableExpression,
  type VariableCatalogue,
  type VariableOffer,
  type VariableSlot,
  type VariableValueShape,
} from "./field-variables.js";
import { fieldSchema } from "./field-schema.js";
import { resolveFields } from "./field-resolution.js";

function slot(overrides: Partial<VariableSlot> = {}): VariableSlot {
  return {
    path: "FieldAcceptance.text",
    mode: "both",
    osfType: "string",
    baseType: "string",
    cardinality: "single",
    nullable: true,
    ...overrides,
  };
}

function offered(overrides: Partial<VariableValueShape> = {}): VariableValueShape {
  return { osfType: "string", baseType: "string", cardinality: "single", ...overrides };
}

const refusal = (slotValue: VariableSlot, offer: VariableValueShape, usage: "whole" | "template" = "whole") => {
  const result = variableCompatibility(slotValue, offer, usage);
  return result.compatible ? undefined : result.code;
};

describe("variable references", () => {
  test("only the two authored namespaces parse, with their scope", () => {
    expect(parseVariableReference("chips.brand.name")).toEqual({
      namespace: "chips",
      scope: "global",
      key: "brand.name",
    });
    expect(parseVariableReference("  local.amount \n")).toEqual({
      namespace: "local",
      scope: "local",
      key: "amount",
    });
    expect(VARIABLE_NAMESPACE_SCOPES).toEqual({ chips: "global", local: "local" });
  });

  test("a key in one namespace never resolves through the other", () => {
    const catalogue: VariableCatalogue = {
      local: { kind: "map", offers: { amount: offered({ osfType: "currency", baseType: "number" }) } },
      chips: { kind: "uniform", offer: offered({ osfType: "multilineText" }) },
    };
    expect(variableOffer(catalogue, parseVariableReference("local.amount")).osfType).toBe("currency");
    // The same key in the global namespace is the globals' own contract, not the local one.
    expect(variableOffer(catalogue, parseVariableReference("chips.amount")).osfType).toBe("multilineText");
    expect(() => variableOffer({ chips: catalogue.chips! }, parseVariableReference("local.amount")))
      .toThrow(/No local variables/);
  });

  test.each([
    "name",
    "global.brand",
    "chips.",
    "chips.x()",
    "local.__proto__",
    "local.a.constructor",
    "local.1st",
    `chips.${"a".repeat(161)}`,
  ])("refuses the unsupported reference %s", (expression) => {
    expect(() => parseVariableReference(expression)).toThrow(VariableError);
    try {
      parseVariableReference(expression);
    } catch (error) {
      expect((error as VariableError).code).toBe("VARIABLE_SYNTAX");
    }
  });

  test("an unknown key is refused rather than resolved to an empty value", () => {
    const catalogue: VariableCatalogue = { local: { kind: "map", offers: {} } };
    try {
      variableOffer(catalogue, parseVariableReference("local.absent"));
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as VariableError).code).toBe("UNKNOWN_VARIABLE");
    }
  });

  test("a prototype key cannot reach a map namespace's inherited properties", () => {
    const catalogue: VariableCatalogue = { local: { kind: "map", offers: {} } };
    expect(() => variableOffer(catalogue, { namespace: "local", scope: "local", key: "toString" }))
      .toThrow(/local.toString is not available/);
  });

  test("only enumerable namespaces list offers", () => {
    const catalogue: VariableCatalogue = {
      chips: { kind: "uniform", offer: offered({ osfType: "multilineText" }) },
      local: { kind: "map", offers: { b: offered(), a: offered({ osfType: "email" }) } },
    };
    expect(variableOffers(catalogue).map((offer) => `${offer.source.namespace}.${offer.source.key}:${offer.osfType}`))
      .toEqual(["local.a:email", "local.b:string"]);
  });
});

describe("whole-value compatibility", () => {
  test("the exact osfType and cardinality are kept", () => {
    expect(variableCompatibility(
      slot({ osfType: "currency", baseType: "number", mode: "whole" }),
      offered({ osfType: "currency", baseType: "number" }),
      "whole",
    )).toEqual({ compatible: true });
    // Money is not an arbitrary number.
    expect(refusal(slot({ osfType: "currency", baseType: "number", mode: "whole" }), offered({ osfType: "number", baseType: "number" })))
      .toBe("INCOMPATIBLE_TYPE");
    // A refined value does fill a destination that declares no refinement.
    expect(refusal(slot({ osfType: "string", mode: "whole" }), offered({ osfType: "multilineText" })))
      .toBeUndefined();
    // No silent promotion between the date types, and no string to number.
    expect(refusal(slot({ osfType: "datetime", baseType: "datetime", mode: "whole" }), offered({ osfType: "date", baseType: "date" })))
      .toBe("INCOMPATIBLE_TYPE");
    expect(refusal(slot({ osfType: "number", baseType: "number", mode: "whole" }), offered()))
      .toBe("INCOMPATIBLE_TYPE");
  });

  test("a scalar and a collection never fill each other", () => {
    expect(refusal(slot({ mode: "whole" }), offered({ cardinality: "collection" })))
      .toBe("INCOMPATIBLE_CARDINALITY");
    expect(refusal(slot({ mode: "whole", cardinality: "collection" }), offered()))
      .toBe("INCOMPATIBLE_CARDINALITY");
    expect(refusal(slot({ mode: "whole", cardinality: "collection" }), offered({ cardinality: "collection" })))
      .toBeUndefined();
  });

  test("a reference only fills the same entity's reference", () => {
    const relation = slot({ osfType: "Relation", mode: "whole", target: "Relation" });
    expect(refusal(relation, offered({ osfType: "Relation", target: "Relation" }))).toBeUndefined();
    expect(refusal(relation, offered({ osfType: "Document", target: "Document" }))).toBe("INCOMPATIBLE_REFERENCE");
    // An arbitrary uuid string is not a Relation.
    expect(refusal(relation, offered())).toBe("INCOMPATIBLE_REFERENCE");
    // Nor does a Relation leak into a plain text field.
    expect(refusal(slot({ mode: "whole" }), offered({ osfType: "Relation", target: "Relation" })))
      .toBe("INCOMPATIBLE_REFERENCE");
  });

  test("a narrower domain needs a declared domain that fits inside it", () => {
    const status = slot({ osfType: "string", mode: "whole", enum: ["open", "closed"] });
    expect(refusal(status, offered({ enum: ["open"] }))).toBeUndefined();
    expect(refusal(status, offered({ enum: ["open", "archived"] }))).toBe("INCOMPATIBLE_DOMAIN");
    expect(refusal(status, offered())).toBe("INCOMPATIBLE_DOMAIN");
    // A destination without a domain takes a value from one.
    expect(refusal(slot({ mode: "whole" }), offered({ enum: ["open"] }))).toBeUndefined();
  });

  test("the mode decides which shapes are accepted at all", () => {
    expect(refusal(slot({ mode: "none" }), offered())).toBe("VARIABLES_NOT_PERMITTED");
    expect(refusal(slot({ mode: "template" }), offered())).toBe("VARIABLES_NOT_PERMITTED");
    expect(refusal(slot({ mode: "whole" }), offered())).toBeUndefined();
    expect(refusal(slot({ mode: "whole" }), offered(), "template")).toBe("VARIABLES_NOT_PERMITTED");
    expect(refusal(slot({ mode: "template" }), offered(), "template")).toBeUndefined();
    expect(refusal(slot({ mode: "both" }), offered(), "template")).toBeUndefined();
  });

  test("assertVariableCompatible throws the compatibility refusal", () => {
    expect(() => assertVariableCompatible(slot({ mode: "whole" }), offered({ cardinality: "collection" }), "whole"))
      .toThrow(/single value/);
  });
});

describe("template compatibility", () => {
  test("only text destinations hold a template", () => {
    expect(refusal(slot({ osfType: "number", baseType: "number" }), offered(), "template")).toBe("INCOMPATIBLE_TYPE");
    expect(refusal(slot({ cardinality: "collection" }), offered(), "template")).toBe("INCOMPATIBLE_TYPE");
    expect(refusal(slot({ osfType: "markdown", mode: "template" }), offered(), "template")).toBeUndefined();
  });

  test("a formattable scalar is spliced in; an object, a collection or a reference is not", () => {
    expect(refusal(slot(), offered({ osfType: "currency", baseType: "number" }), "template")).toBeUndefined();
    expect(refusal(slot(), offered({ osfType: "date", baseType: "date" }), "template")).toBeUndefined();
    expect(refusal(slot(), offered({ osfType: "boolean", baseType: "boolean" }), "template")).toBeUndefined();
    expect(refusal(slot(), offered({ osfType: "labelSet", baseType: "object" }), "template")).toBe("UNFORMATTABLE_VALUE");
    expect(refusal(slot(), offered({ cardinality: "collection" }), "template")).toBe("INCOMPATIBLE_CARDINALITY");
    expect(refusal(slot(), offered({ osfType: "Relation", target: "Relation" }), "template")).toBe("INCOMPATIBLE_REFERENCE");
  });
});

describe("offered variables", () => {
  test("a picker list is the same comparison, applied to a list", () => {
    const offers: VariableOffer[] = [
      { ...offered({ osfType: "currency", baseType: "number" }), source: { namespace: "local", scope: "local", key: "amount" } },
      { ...offered({ osfType: "number", baseType: "number" }), source: { namespace: "local", scope: "local", key: "count" } },
      { ...offered({ osfType: "currency", baseType: "number", cardinality: "collection" }), source: { namespace: "local", scope: "local", key: "amounts" } },
    ];
    expect(compatibleVariableOffers(slot({ osfType: "currency", baseType: "number", mode: "whole" }), offers, "whole")
      .map((offer) => offer.source.key)).toEqual(["amount"]);
  });
});

describe("resolved values", () => {
  test("a source that breaks its own contract is refused, and absent is not null", () => {
    const text: VariableOffer = { ...offered({ osfType: "multilineText" }), source: { namespace: "chips", scope: "global", key: "brand" } };
    expect(() => assertVariableSourceValue(text, "Example")).not.toThrow();
    expect(() => assertVariableSourceValue(text, { name: "Example" })).toThrow(/did not resolve to a string/);
    expect(() => assertVariableSourceValue(text, ["Example"])).toThrow(/did not resolve to a string/);
    expect(() => assertVariableSourceValue(text, undefined)).toThrow(/has no value/);
    expect(() => assertVariableSourceValue(text, null)).toThrow(/not nullable/);
    expect(() => assertVariableSourceValue({ ...text, nullable: true }, null)).not.toThrow();
  });

  test("false, zero, an empty string and an empty collection are values", () => {
    const flag: VariableOffer = { ...offered({ osfType: "boolean", baseType: "boolean" }), source: { namespace: "local", scope: "local", key: "flag" } };
    expect(() => assertVariableSourceValue(flag, false)).not.toThrow();
    const amount: VariableOffer = { ...offered({ osfType: "currency", baseType: "number" }), source: { namespace: "local", scope: "local", key: "amount" } };
    expect(() => assertVariableSourceValue(amount, 0)).not.toThrow();
    const text: VariableOffer = { ...offered(), source: { namespace: "local", scope: "local", key: "note" } };
    expect(() => assertVariableSourceValue(text, "")).not.toThrow();
    const counts: VariableOffer = { ...offered({ osfType: "integer", baseType: "integer", cardinality: "collection" }), source: { namespace: "local", scope: "local", key: "counts" } };
    expect(() => assertVariableSourceValue(counts, [])).not.toThrow();
    expect(() => assertVariableSourceValue(counts, [1, 2.5])).toThrow(/not a integer value/);
  });

  test("base types are read exactly", () => {
    expect(matchesBaseType("integer", 2)).toBe(true);
    expect(matchesBaseType("integer", 2.5)).toBe(false);
    expect(matchesBaseType("number", Number.POSITIVE_INFINITY)).toBe(false);
    expect(matchesBaseType("date", "2026-10-14")).toBe(true);
    expect(matchesBaseType("date", "2026-02-30")).toBe(false);
    expect(matchesBaseType("date", "2026-10-14T00:00:00Z")).toBe(false);
    expect(matchesBaseType("datetime", "2026-10-14T08:30:00Z")).toBe(true);
    expect(matchesBaseType("datetime", "2026-10-14")).toBe(false);
    expect(matchesBaseType("object", { a: 1 })).toBe(true);
    expect(matchesBaseType("object", [])).toBe(false);
    expect(matchesBaseType("object", null)).toBe(false);
  });

  test("text formatting keeps an exact decimal and refuses what has no text form", () => {
    expect(variableText("Acme")).toBe("Acme");
    expect(variableText(12.5)).toBe("12.5");
    expect(variableText(1e21)).toBe("1000000000000000000000");
    expect(variableText(1e-7)).toBe("0.0000001");
    expect(variableText(false)).toBe("false");
    expect(() => variableText(null)).toThrow(VariableError);
    expect(() => variableText(undefined)).toThrow(/text, numeric or boolean/);
    expect(() => variableText({ a: 1 })).toThrow(/text, numeric or boolean/);
    expect(() => variableText([1])).toThrow(/text, numeric or boolean/);
    expect(() => variableText(Number.NaN)).toThrow(/text, numeric or boolean/);
  });

  test("a refusal names the contract, never the value it refused", () => {
    const secret: VariableOffer = { ...offered({ osfType: "multilineText" }), source: { namespace: "chips", scope: "global", key: "api.token" } };
    try {
      assertVariableSourceValue(secret, { token: "s3cret-value" });
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as Error).message).toBe("chips.api.token did not resolve to a string value.");
      expect((error as Error).message).not.toContain("s3cret");
    }
  });
});

describe("the authored field is the slot", () => {
  test("a resolved field carries its own mode, domain, bounds and target", () => {
    const [field] = resolveFields([
      {
        key: "money",
        osfType: "currency",
        variables: "whole",
        required: true,
        validation: { min: 0 },
      },
    ], { osfTypes: { currency: { baseType: "number", label: { en: "Currency amount" } } } });
    expect(fieldVariableSlot(field!, { path: "FieldAcceptance.money" })).toEqual({
      path: "FieldAcceptance.money",
      mode: "whole",
      osfType: "currency",
      baseType: "number",
      cardinality: "single",
      nullable: false,
      validation: { min: 0 },
    });
    const [plain] = resolveFields([{ key: "note", osfType: "string" }], {});
    expect(fieldVariableSlot(plain!).mode).toBe("none");
  });

  test("the mode travels with the projected property, for every transport", () => {
    const [field] = resolveFields([{ key: "body", osfType: "markdown", variables: "template" }], {
      osfTypes: { markdown: { baseType: "string", label: { en: "Markdown" } } },
    });
    expect(fieldSchema(field!)["x-osf-variables"]).toBe("template");
    const [collection] = resolveFields([{ key: "lines", osfType: "string", cardinality: "collection", variables: "whole" }], {});
    const schema = fieldSchema(collection!);
    expect(schema["x-osf-variables"]).toBe("whole");
    expect((schema.items as Record<string, unknown>)["x-osf-variables"]).toBeUndefined();
    const [literal] = resolveFields([{ key: "plain", osfType: "string" }], {});
    expect(fieldSchema(literal!)).not.toHaveProperty("x-osf-variables");
  });
});

describe("whole-token detection", () => {
  test("one token that is the entire value is a whole-value binding", () => {
    expect(wholeVariableExpression("{{local.amount}}")).toBe("local.amount");
    expect(wholeVariableExpression("{{ local.amount }}")).toBe(" local.amount ");
    expect(wholeVariableExpression("Due: {{local.amount}}")).toBeUndefined();
    expect(wholeVariableExpression("{{local.a}}{{local.b}}")).toBeUndefined();
    expect(wholeVariableExpression("plain text")).toBeUndefined();
  });
});
