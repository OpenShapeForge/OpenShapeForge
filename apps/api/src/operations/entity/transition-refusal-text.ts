// SPDX-License-Identifier: BUSL-1.1
import type { OperationError } from "@openshapeforge/operations";
import { sessionRelation } from "../../auth/identity-link.js";
import type { TransitionBinding } from "./transitions.js";

/**
 * The from-state refusal as a person reads it, in both languages, from the
 * authored labels of the entity, the rule, the status field and its states:
 * "Deal is Gewonnen; Winnen kan alleen zolang Status Open is." The English
 * `message` keeps naming keys and values for tools and logs.
 */
export function stateRefusal(binding: TransitionBinding, current: string): { en: string; nl: string } {
  const pick = (value: { en?: string; nl?: string } | undefined, locale: "en" | "nl", fallback: string) =>
    value?.[locale] ?? value?.en ?? fallback;
  const say = (locale: "en" | "nl") => {
    const state = (value: string) => pick(binding.status.values?.[value], locale, value);
    const entity = pick(binding.table.source?.labels, locale, binding.table.source?.authoringEntityName ?? binding.table.name);
    const rule = pick(binding.rule.label, locale, binding.rule.key);
    const field = pick(binding.status.label, locale, binding.status.field);
    const from = binding.rule.from.map(state).join(locale === "nl" ? " of " : " or ");
    return locale === "nl"
      ? `${entity} is ${state(current)}; ${rule} kan alleen zolang ${field} ${from} is.`
      : `${entity} is ${state(current)}; ${rule} is only possible while ${field} is ${from}.`;
  };
  return { en: say("en"), nl: say("nl") };
}

/**
 * A rule that stamps the acting Relation (Deal.win's "Gewonnen door") cannot
 * fire for a session whose account is linked to no Relation. The offer list
 * refuses it up front with this, so the action is not offered, and the write
 * refuses with the same error if it is called anyway.
 */
export function unlinkedActorRefusal(binding: TransitionBinding, session: unknown): OperationError | undefined {
  if (!(binding.rule.stamps ?? []).some((stamp) => stamp.actor === "relation")) return undefined;
  if (sessionRelation(session as Parameters<typeof sessionRelation>[0])) return undefined;
  const rule = { en: binding.rule.label?.en ?? binding.rule.key, nl: binding.rule.label?.nl ?? binding.rule.label?.en ?? binding.rule.key };
  return {
    code: "FORBIDDEN",
    message: `${binding.rule.key} records the acting Relation, and this session is not linked to one.`,
    retryable: false,
    data: { localized: {
      en: `${rule.en} records who did it; your account is not linked to a person.`,
      nl: `${rule.nl} legt vast wie het deed; je account is niet aan een persoon gekoppeld.`,
    } },
  };
}
