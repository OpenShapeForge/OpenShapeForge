// SPDX-License-Identifier: BUSL-1.1
import { DECIMAL_PATTERN } from "./scalar-projection.js";

export type MoneyDisplay = { readonly decimalPlaces?: number; readonly scale?: "units" | "thousands" | "millions"; readonly currency?: string; readonly locale?: string };
/** Exact presentation only. The source decimal and arithmetic are never rewritten. */
export function formatMoneyDisplay(amount: string, options: MoneyDisplay = {}): string {
  if (amount.length > 4096 || !new RegExp(DECIMAL_PATTERN).test(amount)) throw new Error("Money display requires canonical decimal text.");
  const currency = options.currency ?? "EUR", locale = options.locale ?? "en-US";
  const formatter = new Intl.NumberFormat(locale, { style: "currency", currency });
  const places = options.decimalPlaces ?? formatter.resolvedOptions().minimumFractionDigits ?? 2;
  if (!Number.isSafeInteger(places) || places < 0 || places > 20) throw new Error("Decimal places must be an integer from 0 to 20.");
  const scale = options.scale ?? "units";
  if (!["units", "thousands", "millions"].includes(scale)) throw new Error("Unsupported money display scale.");
  const shift = scale === "millions" ? 6 : scale === "thousands" ? 3 : 0;
  const negative = amount.startsWith("-"), [integer, fraction = ""] = amount.replace(/^-/, "").split(".");
  let digits = BigInt(integer! + fraction);
  const precision = fraction.length + shift;
  if (precision > places) { const divisor = 10n ** BigInt(precision - places); digits = (digits + divisor / 2n) / divisor; }
  else digits *= 10n ** BigInt(places - precision);
  const divisor = 10n ** BigInt(places), whole = digits / divisor;
  const digitFormat = new Intl.NumberFormat(locale, {useGrouping:false});
  const localizedDigits = Array.from({length:10}, (_, digit) => digitFormat.format(digit));
  const decimals = (digits % divisor).toString().padStart(places, "0").replace(/\d/g, digit => localizedDigits[Number(digit)]!);
  // Intl supplies grouping, currency placement and locale punctuation for an exact BigInt.
  const parts = new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: places, maximumFractionDigits: places }).formatToParts(negative && digits !== 0n ? -whole : whole);
  let result = parts.map(part => part.type === "fraction" ? decimals : part.value).join("");
  // -0n has no sign, but a negative fractional amount does.
  if (negative && digits !== 0n && whole === 0n) {
    const signed = new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: places, maximumFractionDigits: places }).formatToParts(-1n);
    const magnitude = parts.filter(part => ["integer", "group", "decimal", "fraction"].includes(part.type)).map(part => part.type === "fraction" ? decimals : part.value).join("");
    let inserted = false;
    result = signed.map(part => { if (["integer", "group", "decimal", "fraction"].includes(part.type)) { if (inserted) return ""; inserted = true; return magnitude; } return part.value; }).join("");
  }
  const language = new Intl.Locale(locale).language;
  return result + (scale === "units" ? "" : language === "nl" ? scale === "thousands" ? " duizend" : " miljoen" : scale === "thousands" ? " thousand" : " million");
}
