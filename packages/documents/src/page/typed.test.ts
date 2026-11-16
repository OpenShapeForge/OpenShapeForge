// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { renderPageBlock } from "./html.js";
import { DEFAULT_PAGE_DESIGN } from "./types.js";

const t = (en: string, nl: string) => ({ type: "string", title: en, "x-osf-i18n": { title: { en, nl } } });
const schema = {
  type: "object", required: ["lines", "totals"],
  properties: {
    lines: { type: "array", title: "Lines", "x-osf-i18n": { title: { en: "Lines", nl: "Regels" } }, items: { type: "object", properties: { product: t("Product", "Product"), amount: t("Amount", "Bedrag") } } },
    totals: { type: "object", title: "Totals", properties: { oneOff: t("One-off", "Eenmalig"), contractValue: t("Contract value", "Contractwaarde") } },
    subscription: { type: ["object", "null"], properties: { termMonths: t("Term", "Looptijd") } },
  },
};
const value = { lines: [{ product: "Security <assessment>", amount: "€ 10.200,00" }], totals: { oneOff: "€ 10.200,00", contractValue: "" }, subscription: null };
const block = (locale = "nl") => ({ id: "p", definitionKey: "QuotePricing", values: value, region: "body" as const, typed: { schema, locale } });

describe("a materialized block on a page", () => {
  test("draws lists as tables with the authored labels and objects as label rows", () => {
    const html = renderPageBlock(block(), DEFAULT_PAGE_DESIGN);
    expect(html).toContain('<div role="columnheader" class="c">Product</div><div role="columnheader" class="c n">Bedrag</div>');
    expect(html).toContain("Security &#60;assessment&#62;");
    expect(html).toContain('<div role="rowheader" class="c">Eenmalig</div><div role="cell" class="c n">€ 10.200,00</div>');
    expect(html).not.toContain("Contractwaarde");
    expect(html).not.toContain("Looptijd");
    expect(renderPageBlock(block("en"), DEFAULT_PAGE_DESIGN)).toContain(">Amount</div>");
  });
  test("draws only the columns a list names, in that order, with their width and alignment", () => {
    const item = { type: "object", properties: { amount: t("Amount", "Bedrag"), discount: t("Discount", "Korting"), product: t("Product", "Product"), quantity: t("Quantity", "Aantal") } };
    const lines = { type: "array", title: "Lines", items: item, "x-osf-presentation": { columns: [{ field: "product" }, { field: "quantity", width: 72, align: "center" }, { field: "missing" }, { field: "amount", width: 140, align: "end" }] } };
    const html = renderPageBlock({ id: "p", definitionKey: "QuotePricing", region: "body" as const, typed: { schema: { type: "object", properties: { lines } }, locale: "nl" },
      values: { lines: [{ product: "Pentest", quantity: "17", amount: "EUR 10,200.00", discount: "10%" }] } }, DEFAULT_PAGE_DESIGN);
    expect(html).toContain('<div role="columnheader" class="c">Product</div><div role="columnheader" class="c p" style="flex:0 0 72px">Aantal</div><div role="columnheader" class="c n" style="flex:0 0 140px">Bedrag</div>');
    expect(html).toContain('<div role="cell" class="c">Pentest</div><div role="cell" class="c m" style="flex:0 0 72px">17</div><div role="cell" class="c n" style="flex:0 0 140px">EUR 10,200.00</div>');
    expect(html).not.toContain("Korting");
    expect(html).not.toContain("10%");
  });
  test("refuses a value that does not match its schema", () => {
    expect(() => renderPageBlock({ ...block(), values: { lines: "x" } }, DEFAULT_PAGE_DESIGN)).toThrow();
  });
});

describe("which blocks a document draws from their output schema", () => {
  test("only blocks the page renderer does not draw itself", async () => {
    const { typedSchema } = await import("../document-pages.js");
    const definition = { renderers: { document: "entityFields" }, materializationSchema: { properties: { value: schema } } };
    const definitions = { TextBlock: definition, QuotePricing: definition } as never;
    const materialized = (definitionKey: string) => ({ id: "x", definitionKey, path: ["x"], values: {}, materialization: { result: { kind: "block", value } } }) as never;
    expect(typedSchema(materialized("QuotePricing"), definitions)).toBe(schema);
    expect(typedSchema(materialized("TextBlock"), definitions)).toBeUndefined();
  });
});
