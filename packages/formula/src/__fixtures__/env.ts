// SPDX-License-Identifier: BUSL-1.1
// A product with authored fields, customer fields and an owned single child
// (`pricing`, a ProductPricing), as the tests bind formulas against it.
import type { FormulaEnvironment, FormulaRecord } from "../types.js";

export const env: FormulaEnvironment = [
  { id: "title", label: "Title", key: "title", type: "text", scope: "self" },
  { id: "category", label: "Category", key: "category", type: "text", scope: "self" },
  { id: "f-cap", label: "Capacity kWh", key: "capacityKwh", type: "number", scope: "self" },
  { id: "f-ppk", label: "Price per kWh", key: "pricePerKwh", type: "number", scope: "self" },
  { id: "f-active", label: "Active", key: "active", type: "boolean", scope: "self" },
  { id: "f-launch", label: "Launch date", key: "launchDate", type: "date", scope: "self" },
  { id: "f-seen", label: "Last seen", key: "lastSeen", type: "timestamp", scope: "self" },
  { id: "f-cost", label: "Cost {net}", key: "costNet", type: "number", scope: "self" },
  { id: "f-margin", label: "Margin", key: "margin", type: "number", scope: "self", classified: true },
  { id: "f-supplier", label: "Supplier", key: "supplier", type: "Organization", scope: "self" },
  {
    id: "f-total",
    label: "Total",
    key: "total",
    type: "number",
    scope: "self",
    kind: "formula",
    depth: 1,
    dependencies: [
      { id: "f-cap", scope: "self" },
      { id: "f-ppk", scope: "self" },
    ],
  },
  { id: "amount", label: "Amount", key: "amount", type: "number", scope: { relation: "pricing" } },
  { id: "currency", label: "Currency", key: "currency", type: "text", scope: { relation: "pricing" } },
];

export const record: FormulaRecord = {
  id: "0b3c6f1e-0000-4000-8000-000000000001",
  createdAt: "2026-01-15T09:30:00.000Z",
  title: "Home battery",
  category: "storage",
  "f-cap": 13.5,
  "f-ppk": 400,
  "f-active": true,
  "f-launch": "2026-03-01",
  "f-seen": "2026-04-02T10:15:00.000Z",
  "f-cost": "4250.00",
  "f-total": 5400,
  pricing: { amount: 499.95, currency: "EUR" },
};

/** The `[start, end]` of the first occurrence of `part` in `text`. */
export function spanOf(text: string, part: string, from = 0): [number, number] {
  const start = text.indexOf(part, from);
  if (start < 0) throw new Error(`'${part}' does not occur in '${text}'`);
  return [start, start + part.length];
}
