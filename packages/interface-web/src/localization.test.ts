// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { missingLocalizedMetadata, missingSchemaUiTranslations, localizeInputSchema, missingUiTranslations, normalizeUiLocale, uiText } from "./localization.js";

describe("UI locale contract", () => {
  test("normalizes regional tags and uses English for unsupported or malformed tags", () => {
    for (const tag of ["nl", "nl-NL", "NL_be", " nl-BE "]) expect(normalizeUiLocale(tag)).toBe("nl");
    for (const tag of ["en-US", "fr", "", undefined, 1, "../nl"]) expect(normalizeUiLocale(tag)).toBe("en");
    expect(uiText({ en: "Name" }, "nl")).toBe("Name");
  });
  test("resolves nested schema presentation without translating defaults, enum values or constants", () => {
    const schema = { type: "object", properties: { products: { type: "array", items: { type: "object", properties: {
      kind: { type: "string", enum: ["service"], default: "service", "x-osf-i18n": {
        title: { en: "Kind", nl: "Soort" }, enum: { service: { en: "Service", nl: "Dienst" } },
      } },
      name: { type: "string", default: "Customer supplied name" },
    } } } } };
    const nl = localizeInputSchema(schema, "nl");
    expect((nl.properties.products.items.properties.kind as any).title).toBe("Soort");
    expect(nl.properties.products.items.properties.kind.enum).toEqual(["service"]);
    expect(nl.properties.products.items.properties.name.default).toBe("Customer supplied name");
    expect(schema.properties.products.items.properties.kind).not.toHaveProperty("title");
    expect(nl.properties.products.items.properties.kind["x-osf-i18n"].title.en).toBe("Kind");
  });
  test("detects missing nested labels and choice translations", () => {
    expect(missingUiTranslations({ properties: { kind: { "x-osf-i18n": {
      title: { en: "Kind" }, enum: { service: { nl: "Dienst" } },
    } } } })).toEqual(["properties.kind.x-osf-i18n.title.nl", "properties.kind.x-osf-i18n.enum.service.en"]);
  });
});

test("diagnoses original metadata and output labels before fallback", () => {
  expect(missingLocalizedMetadata({ label: { nl: "Naam" }, operations: { action: { name: { en: "Run" } } } }, "Entity"))
    .toEqual(["Entity.label.en", "Entity.operations.action.name.nl"]);
  expect(missingSchemaUiTranslations({ type: "object", properties: { customerName: { type: "string" } } }, "offer.output"))
    .toContain("offer.output.properties.customerName.x-osf-i18n.title");
  expect(missingLocalizedMetadata({ defaultValue: { label: { en: "Customer data" } } })).toEqual([]);
  // An anyOf branch that restates a required name with a boolean schema names no field to label.
  expect(missingSchemaUiTranslations({
    type: "object",
    properties: { amount: { type: "number", "x-osf-i18n": { title: { en: "Amount", nl: "Bedrag" } } } },
    anyOf: [{ required: ["amount"], properties: { amount: true } }],
  }, "milestone.input")).toEqual([]);
});
