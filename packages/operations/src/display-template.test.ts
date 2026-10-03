// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { renderTemplate, templatePaths, templateSelection } from "./display-template.js";

test("a nested display template reads, selects and renders through one parser", () => {
  // PeriodBalance: displayTemplate "{{ledgerAccount.code}}"; InvoiceVatBucket names a nested rate too.
  const template = "{{ledgerAccount.code}} {{period.label || period.key}} ({{amount}})";
  expect(templatePaths(template)).toEqual([["ledgerAccount", "code"], ["period", "label"], ["period", "key"], ["amount"]]);
  expect(templateSelection(template)).toBe("id ledgerAccount { code } period { label key } amount");
  expect(templateSelection("{{code}}", ["code", "id"])).toBe("id code");
  expect(renderTemplate(template, { id: "x", ledgerAccount: { code: "4000" }, period: { key: "2026-Q1" }, amount: 12 }))
    .toBe("4000 2026-Q1 (12)");
  // A missing nested value renders nothing rather than "[object Object]"; nothing at all falls back to the id.
  expect(renderTemplate("{{ledgerAccount.code}}", { id: "x", ledgerAccount: { code: null } })).toBe("x");
  expect(renderTemplate("{{ledgerAccount}}", { id: "x", ledgerAccount: { code: "4000" } })).toBe("x");
});

test("only identifier segments reach a selection; anything else is dropped", () => {
  expect(templatePaths("{{ a.b }} {{ c-d }} {{ e..f }} {{__proto__.x}}")).toEqual([["a", "b"], ["__proto__", "x"]]);
  expect(templateSelection("{{ c-d }}")).toBe("id");
});
