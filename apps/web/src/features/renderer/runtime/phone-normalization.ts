// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";

const phoneSemanticTypes = new Set([
  "phone",
  "telephone",
  "telefoon",
  "telefoonnummer",
  "phonenumber",
  "mobilephone",
  "mobiel",
  "whatsappphone",
  "whatsappphonenumber",
]);

export function isPhoneSemanticField(field: Pick<Field, "semanticType">) {
  const semanticType = field.semanticType?.trim().toLowerCase();
  return Boolean(semanticType && phoneSemanticTypes.has(semanticType));
}

export function normalizePhoneInput(
  value: string | null | undefined,
  options: { defaultCountry?: "NL" } = {},
) {
  const stripped = (value ?? "").trim().replace(/[\s().-]/g, "");
  if (!stripped) return "";
  if (/^\+[1-9][0-9]{6,14}$/.test(stripped)) return stripped;
  if (/^00[1-9][0-9]{6,14}$/.test(stripped)) return `+${stripped.slice(2)}`;
  if (options.defaultCountry === "NL" || options.defaultCountry === undefined) {
    if (/^31[1-9][0-9]{7,13}$/.test(stripped)) return `+${stripped}`;
    if (/^0[1-9][0-9]{7,13}$/.test(stripped)) return `+31${stripped.slice(1)}`;
  }
  return stripped;
}

export function normalizePhoneSemanticValue(field: Field, value: unknown) {
  if (!isPhoneSemanticField(field) || typeof value !== "string") {
    return value;
  }
  return normalizePhoneInput(value, { defaultCountry: "NL" });
}
