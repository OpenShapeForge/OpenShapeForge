// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import rawCatalog from "../../generated/operations/catalog.json" with { type: "json" };
import type { OperationContract } from "../runtime.js";
import { getGeneratedCrudTables } from "./catalog.js";
import { notAuthorizedRefusal } from "./authorization-refusal-text.js";
import { unlinkedActorRefusal } from "./transition-refusal-text.js";
import { transitionBinding, transitionRefusal } from "./transitions.js";

const trigger = (rawCatalog as { operations: OperationContract[] }).operations
  .find((operation) => operation.key === "AgreementMilestone.trigger")!;

describe("refusals a person reads, in both languages (#887, #932)", () => {
  test("a rule refused for its state names the entity, the rule and the states by their labels", () => {
    const refusal = transitionRefusal(transitionBinding(trigger), { status: "invoiced" });
    expect(refusal?.message).toBe("AgreementMilestone is invoiced; trigger moves status from pending to triggered.");
    const localized = (refusal?.data as { localized: { en: string; nl: string } }).localized;
    expect(localized.nl).toMatch(/ is Gefactureerd; Triggeren kan alleen zolang Status In afwachting is\.$/u);
    expect(localized.en).toMatch(/ is Invoiced; Trigger is only possible while Status is Pending\.$/u);
  });

  test("the entity role guard keeps its English message and adds the entity's Dutch label", () => {
    const table = getGeneratedCrudTables().find((candidate) => candidate.source?.authoringEntityName === "Task")!;
    expect(notAuthorizedRefusal(table, "update")).toEqual({
      code: "FORBIDDEN",
      message: "Not authorized to update Task.",
      data: { localized: { en: "Not authorized to update Task.", nl: "Geen toestemming om Taak te wijzigen." } },
    });
    expect(notAuthorizedRefusal(table, "list").data.localized.nl).toBe("Geen toestemming om Taak te bekijken.");
    // The record-permission guard refuses with the same shape for its own actions.
    expect(notAuthorizedRefusal(table, "edit").data.localized).toEqual({ en: "Not authorized to edit Task.", nl: "Geen toestemming om Taak te wijzigen." });
    expect(notAuthorizedRefusal(table, "view").message).toBe("Not authorized to view Task.");
  });

  test("a rule that stamps the acting Relation is refused up front for an unlinked session, in both languages", () => {
    const base = transitionBinding(trigger);
    const binding = { ...base, rule: { ...base.rule, label: { en: "Win", nl: "Winnen" }, stamps: [{ field: "wonByRelationId", value: "actor" as const, actor: "relation" as const }] } };
    const refusal = unlinkedActorRefusal(binding, { tenantId: "t", userId: "u", roles: [] });
    expect(refusal).toMatchObject({ code: "FORBIDDEN", retryable: false, data: { localized: {
      en: "Win records who did it; your account is not linked to a person.",
      nl: "Winnen legt vast wie het deed; je account is niet aan een persoon gekoppeld.",
    } } });
    expect(unlinkedActorRefusal(binding, { relation: { status: "linked", relationId: "r", displayName: "Vera" } })).toBeUndefined();
    expect(unlinkedActorRefusal(base, {})).toBeUndefined();
  });
});
