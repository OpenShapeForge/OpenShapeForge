// SPDX-License-Identifier: BUSL-1.1
import type { PolicyConditionLanguage } from "./types";

export function labels(lang: PolicyConditionLanguage) {
  return {
    conditionType: lang === "nl" ? "Voorwaardetype" : "Condition type",
    roles: lang === "nl" ? "Rollen" : "Roles",
    groups: lang === "nl" ? "Groepen" : "Groups",
    field: lang === "nl" ? "Veld" : "Field",
    operator: lang === "nl" ? "Operator" : "Operator",
    value: lang === "nl" ? "Waarde" : "Value",
    commaSeparated:
      lang === "nl" ? "Komma-gescheiden waarden" : "Comma-separated values",
    addValue: lang === "nl" ? "Waarde toevoegen" : "Add value",
    removeValue: lang === "nl" ? "Waarde verwijderen" : "Remove value",
    addCondition: lang === "nl" ? "Voorwaarde toevoegen" : "Add condition",
    removeCondition:
      lang === "nl" ? "Voorwaarde verwijderen" : "Remove condition",
    emptyGroup:
      lang === "nl" ? "Nog geen voorwaarden." : "No conditions yet.",
    noExtraInput:
      lang === "nl"
        ? "Deze voorwaarde heeft geen extra invoer."
        : "This condition has no extra input.",
  };
}
