// SPDX-License-Identifier: BUSL-1.1
import type { GeneratedCrudTable } from "./types.js";

/** What a refused action is, per generated operation and record permission. */
const VERB: Record<string, { en: string; nl: string }> = {
  list: { en: "list", nl: "te bekijken" },
  get: { en: "get", nl: "te bekijken" },
  view: { en: "view", nl: "te bekijken" },
  create: { en: "create", nl: "aan te maken" },
  update: { en: "update", nl: "te wijzigen" },
  edit: { en: "edit", nl: "te wijzigen" },
  delete: { en: "delete", nl: "te verwijderen" },
};

/**
 * The entity role guard's refusal. `message` stays the English sentence
 * naming the authored entity (tools and logs read it); both languages travel
 * as `data.localized`, the runtime's bilingual convention a host renders in
 * the viewer's language, built from the entity's authored labels:
 * "Geen toestemming om Verkoopproces te wijzigen."
 */
export function notAuthorizedRefusal(table: GeneratedCrudTable, action: string) {
  const name = table.source?.authoringEntityName ?? table.name;
  const verb = VERB[action] ?? { en: action, nl: action };
  const label = { en: table.source?.labels?.en ?? name, nl: table.source?.labels?.nl ?? table.source?.labels?.en ?? name };
  return {
    code: "FORBIDDEN",
    message: `Not authorized to ${action} ${name}.`,
    data: { localized: { en: `Not authorized to ${verb.en} ${label.en}.`, nl: `Geen toestemming om ${label.nl} ${verb.nl}.` } },
  };
}
