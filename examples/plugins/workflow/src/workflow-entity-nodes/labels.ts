// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
import type { WorkflowAction } from "./types.js";

export function getActionLabel(entityLabels: { en: string; nl: string }, action: WorkflowAction) {
  switch (action) {
    case "create":
      return { en: `Create ${entityLabels.en}`, nl: `${entityLabels.nl} aanmaken` };
    case "getOne":
      return { en: `Get ${entityLabels.en}`, nl: `${entityLabels.nl} ophalen` };
    case "list":
      return { en: `List ${entityLabels.en}`, nl: `${entityLabels.nl} lijst` };
    case "update":
      return { en: `Update ${entityLabels.en}`, nl: `${entityLabels.nl} bijwerken` };
    case "delete":
      return { en: `Delete ${entityLabels.en}`, nl: `${entityLabels.nl} verwijderen` };
    case "wait":
      return { en: `Wait For ${entityLabels.en}`, nl: `Wacht op ${entityLabels.nl.toLowerCase()}` };
    case "awaitAction":
      return { en: `Await Action — ${entityLabels.en}`, nl: `Wacht op actie — ${entityLabels.nl}` };
  }
}

export function getActionDescription(entityLabels: { en: string; nl: string }, action: WorkflowAction) {
  switch (action) {
    case "create":
      return {
        en: `Creates a new ${entityLabels.en.toLowerCase()} instance.`,
        nl: `Maakt een nieuwe ${entityLabels.nl.toLowerCase()}-instantie aan.`,
      };
    case "getOne":
      return {
        en: `Fetches a single ${entityLabels.en.toLowerCase()} by ID.`,
        nl: `Haalt één ${entityLabels.nl.toLowerCase()} op via het ID.`,
      };
    case "list":
      return {
        en: `Fetches multiple ${entityLabels.en.toLowerCase()} records.`,
        nl: `Haalt meerdere ${entityLabels.nl.toLowerCase()}-records op.`,
      };
    case "update":
      return {
        en: `Updates an existing ${entityLabels.en.toLowerCase()} instance.`,
        nl: `Werkt een bestaande ${entityLabels.nl.toLowerCase()}-instantie bij.`,
      };
    case "delete":
      return {
        en: `Deletes a ${entityLabels.en.toLowerCase()} instance.`,
        nl: `Verwijdert een ${entityLabels.nl.toLowerCase()}-instantie.`,
      };
    case "wait":
      return {
        en: `Waits until a ${entityLabels.en.toLowerCase()} event matches the configured condition.`,
        nl: `Wacht totdat een ${entityLabels.nl.toLowerCase()}-event voldoet aan de ingestelde voorwaarde.`,
      };
    case "awaitAction":
      return {
        en: `Pauses until a user triggers one of the declared actions on a ${entityLabels.en.toLowerCase()}.`,
        nl: `Pauzeert totdat een gebruiker een van de gedeclareerde acties triggert op een ${entityLabels.nl.toLowerCase()}.`,
      };
  }
}
