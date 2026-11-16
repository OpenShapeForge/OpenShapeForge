// SPDX-License-Identifier: BUSL-1.1
import { decimalText, formatMoneyDisplay } from "@openshapeforge/operations";

type Schema = Readonly<Record<string, unknown>>;
const isObject = (value: unknown): value is Schema => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Where a money value of a block's output is read: the objects it sits in,
 * outermost first, and the locale its notation follows.
 */
export type MoneyScope = { readonly records: readonly Schema[]; readonly locale: string };

/**
 * The locale a block's amounts are written in: the one its output schema
 * states (`x-osf-presentation.locale` on the value), else the document's.
 */
export function moneyScope(schema: unknown, locale: string): MoneyScope {
  const presentation = isObject(schema) && isObject(schema["x-osf-presentation"]) ? schema["x-osf-presentation"].locale : undefined;
  return { records: [], locale: typeof presentation === "string" && presentation ? presentation : locale };
}

export const within = (scope: MoneyScope, record: Schema): MoneyScope => ({ ...scope, records: [...scope.records, record] });

export const isMoneySchema = (schema: Schema): boolean => schema["x-osf-type"] === "money";

/**
 * A `money` value as the platform writes money (the formatter of the type).
 * `x-osf-currency` names the field that holds the ISO code, in the object
 * the amount sits in or the nearest one around it. `undefined` when the
 * value is not an amount or no currency is found: the caller refuses.
 */
export function moneyText(value: unknown, schema: Schema, scope: MoneyScope): string | undefined {
  const field = schema["x-osf-currency"];
  if (typeof field !== "string") return undefined;
  let currency: unknown;
  for (let index = scope.records.length - 1; index >= 0 && currency === undefined; index--) {
    if (Object.hasOwn(scope.records[index]!, field)) currency = scope.records[index]![field];
  }
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return undefined;
  const amount = typeof value === "number" || typeof value === "string" ? decimalText(value) : undefined;
  if (typeof amount !== "string") return undefined;
  try { return formatMoneyDisplay(amount, { currency, locale: scope.locale }); } catch { return undefined; }
}
