// SPDX-License-Identifier: BUSL-1.1
/**
 * The sentence a session opens with: who the assistant is assisting, at
 * which organization, what that person may do, and in which language to
 * answer — written in that language.
 *
 *   Je assisteert Hans Eilers bij Zerocopter; Hans Eilers is
 *   organisatiebeheerder en mag assessments en bevindingen beheren en
 *   offertes en de catalogus beheren. Antwoord in het Nederlands.
 *
 * `initialize` is authenticated (a bearer token on every organization
 * endpoint), so the server knows all of this before it answers, and the
 * `instructions` field of that answer is the one text every client hands
 * its model unasked. It goes FIRST, before the onboarding sentence and the
 * general guidance, because it is the one thing that differs per session.
 *
 * Addressed to the model, like every instruction on this transport: "you
 * assist X" tells the assistant whose assistant it is; the person never
 * reads this. Roles are said in the same plain words `whoami` uses
 * (`session-labels.ts`), never as the realm's role names.
 *
 * A session without a person — an API key, the development identity without
 * a name, a tenant the registry cannot name — gets NO sentence rather than a
 * sentence with holes: "You assist an unnamed user at an unknown
 * organization" tells the model nothing and reads as a fault.
 */
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { ResolvedLocale } from "./locale.js";
import { sessionIdentityOf, sessionLocale } from "./session-identity.js";
import { readSessionOrganization } from "./session-describe.js";
import {
  classifyRoles,
  describePermissions,
  joinPhrases,
  type PhraseLanguage,
} from "./session-labels.js";

export type OpeningSentenceInput = {
  /** The person's display name; null means no sentence. */
  name: string | null;
  /** The organization's display name; null means no sentence. */
  organization: string | null;
  /** The session's effective roles (`TrustedSessionContext.roles`). */
  roles: readonly string[];
  /** The language the session reads, from `sessionLocale`. */
  locale: ResolvedLocale;
};

/** The languages the sentence is authored in; anything else is answered in English. */
function sentenceLanguage(locale: ResolvedLocale): PhraseLanguage {
  return locale.tag === "nl" ? "nl" : "en";
}

function englishArticle(phrase: string): string {
  return /^[aeiou]/i.test(phrase) ? "an" : "a";
}

/**
 * Pure. Null when `name` or `organization` is missing — never a half sentence.
 * With neither a composite role nor a describable permission the sentence
 * still closes, saying the person has no roles yet.
 */
export function openingSentence(input: OpeningSentenceInput): string | null {
  const { name, organization, locale } = input;
  if (!name || !organization) return null;
  const language = sentenceLanguage(locale);
  const { composite, permissions } = classifyRoles(input.roles);
  const may = joinPhrases(describePermissions(permissions, language), language);

  if (language === "nl") {
    const role = composite ? `is ${composite.phrase.nl}` : null;
    const rights = may ? `mag ${may}` : null;
    const about =
      role && rights
        ? `${name} ${role} en ${rights}`
        : role
          ? `${name} ${role}`
          : rights
            ? `${name} ${rights}`
            : `${name} heeft nog geen rollen`;
    return `Je assisteert ${name} bij ${organization}; ${about}. Antwoord in het Nederlands.`;
  }

  const role = composite
    ? `is ${englishArticle(composite.phrase.en)} ${composite.phrase.en}`
    : null;
  const rights = may ? `may ${may}` : null;
  const about =
    role && rights
      ? `${name} ${role} and ${rights}`
      : role
        ? `${name} ${role}`
        : rights
          ? `${name} ${rights}`
          : `${name} has no roles yet`;
  return `You assist ${name} at ${organization}; ${about}. Answer in ${locale.englishName}.`;
}

/**
 * The sentence for one live session, or null. Reads the person from the
 * credential's display facts (`session-identity.ts`) and the organization's
 * display name from the registry under the session's own row-level policy;
 * the roles are the session's own.
 */
export async function sessionOpeningSentence(input: {
  db: OpenShapeForgeDatabase;
  session: TrustedSessionContext;
}): Promise<string | null> {
  const identity = sessionIdentityOf(input.session);
  if (!identity.name) return null;
  const organization = await readSessionOrganization(input.db, input.session);
  return openingSentence({
    name: identity.name,
    organization: organization?.name ?? null,
    roles: input.session.roles ?? [],
    locale: sessionLocale(input.session),
  });
}
