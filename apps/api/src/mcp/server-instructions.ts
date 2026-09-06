// SPDX-License-Identifier: BUSL-1.1
/**
 * The server's `initialize` instructions — the one text every client hands
 * its model unasked — assembled from the fixed guidance and the parts that
 * vary per session.
 *
 * Every sentence here is addressed to the model as the person's assistant;
 * the person never reads it. The order is deliberate:
 *
 *   1. the opening sentence — who this person is (`session-opening.ts`);
 *   2. what the server is, and the OAuth redirect URL when Adapters exist;
 *   3. the guides that must be read before creating something;
 *   4. data acquisition — how to fill in a field;
 *   5. first-use onboarding (`onboarding.ts`);
 *   6. audience, vocabulary and presentation, told which client it faces;
 *   7. the person's language (`locale.ts`);
 *   8. update notices (`update-notices.ts`).
 *
 * The per-session parts (1, 6, 7) are resolved once, when the server for the
 * session is built, and never re-read: a second resolution could only
 * disagree with the first.
 */
import type { ResolvedLocale } from "./locale.js";
import { ONBOARDING_INSTRUCTION } from "./onboarding.js";
import { connectedViaLabel, type McpClientInfo } from "./session-client.js";
import { UPDATE_INSTRUCTION } from "./update-notices.js";

export const ENTITY_CATALOG_URI = "osf://schema/entities";

export const INSTRUCTIONS =
  "Entity CRUD for an OpenShapeForge deployment. Every tool is scoped to the " +
  "caller's tenant and roles; results are row-level filtered by the database. " +
  "List tools return a page plus a nextCursor — pass it back as `after` to " +
  "continue. Prefer filtering over paging through large result sets.";

/**
 * Data acquisition — how to get a field's value, generalized beyond any one
 * entity. A `create`/`update` tool's description or field hints may narrow
 * this for their own fields (a stated YAML default, a note that a value is
 * server-issued); this is the fallback order for everything else. Appended
 * to every session's server `instructions` (this is a fixed, one-time read,
 * not per-tool — see DATA_ACQUISITION_TOOL_FOOTER for the per-tool reminder).
 */
export const DATA_ACQUISITION_GUIDANCE =
  " Data acquisition — how to fill in a field, in order: (1) derive it from " +
  "what already exists (a related record, an Agreement or a prior record of " +
  "the same kind, stored personal instructions or onboarding answers) " +
  "before asking anyone; (2) when it would help and you can, look the " +
  "client up online (their site, a registration/chamber-of-commerce lookup) " +
  "to infer things like sector, size or likely scope — propose these, " +
  "never state them as established fact; (3) accept the tool's own " +
  "defaults and anything the server fills in for you (a field's " +
  "description says when this applies) rather than asking for a value that " +
  "already has one; (4) if one genuine question remains, ask it as a " +
  "single confirmation or choice, not one question per field; (5) only for " +
  "secrets or many linked fields at once, point the person to this " +
  "deployment's configuration form. Never ask field-by-field: propose one " +
  "complete draft from the above and let the person confirm or edit it " +
  "once, then act according to the assistance level they have set for you." +
  " Learning loop — when the same person corrects the same thing more than " +
  "once in a session (the same field changed the same way, the same " +
  "ordering, the same thing left out), offer ONCE, at a natural pause, to " +
  "store that as their standing instruction with set_my_preferences, and " +
  "say what you would store. Offer it once, not on every repetition, and " +
  "not again in that session if they decline; and only where the tool's " +
  "own description says personal instructions are allowed on it — a tool " +
  "whose organization forbids them refuses the write, so never offer there. " +
  "This is about acting on what you already noticed in this conversation; " +
  "nothing records it for you.";

/**
 * The short reminder every generated `create`/`update` tool carries in its
 * own description (see describeTool in generated-mcp-server.ts) — the full
 * order above lives once in the server's `instructions` rather than being
 * repeated on every tool.
 */
export const DATA_ACQUISITION_TOOL_FOOTER =
  " Filling this in: derive values from existing records, defaults and " +
  "server-issued fields before asking; propose one complete draft rather " +
  "than asking field-by-field. See this server's instructions for the full " +
  "order.";

/**
 * Talking to a person — the audience rule this server had no way to state,
 * and the two mistakes it kept producing. A pentester asked for an
 * explanation and got the server's own vocabulary back ("Relation",
 * "Assessment", `assessment_create`), with a guide written for the assistant
 * read out to them verbatim.
 *
 * Both are the same boundary, the one that already holds elsewhere on this
 * transport: an instruction is FOR the model; material passes THROUGH the
 * model to a person. A guide is an instruction, so it is never quoted. This
 * text is one too.
 *
 * The room here is deliberately spent on what a model cannot work out for
 * itself — that this deployment's word for a record is not the word in its
 * table — and not on what it already knows, such as what makes a chart
 * readable. The presentation rules (5-7) are here rather than in a client's
 * own prompt because they are the same rules: they say what may leave you and
 * in what shape, and rule 6 is what keeps a client that cannot draw from
 * losing half the answer.
 */
const AUDIENCE_AND_PRESENTATION_GUIDANCE =
  " Talking to a person — these rules are about what leaves you, not about " +
  "what you read. (1) Use their words for the subject, never this server's " +
  "storage names: a Relation is the party the record describes (a client, a " +
  "supplier, a colleague), an Assessment is the engagement you are doing for " +
  "them, a TestTarget is a system in scope, a Finding is something you found. " +
  "Each entity carries an authored label in the person's own language — the " +
  `${ENTITY_CATALOG_URI} resource and a Service's own field labels have it — ` +
  "and that label is the word their colleagues use; prefer it over anything " +
  "you would translate yourself. (2) Never say a tool name, an entity name " +
  "or a field name to a person: `assessment_create`, `relationId` and " +
  "`deliveryMode` are your tooling, not their subject. If a sentence only " +
  "makes sense to someone who knows this API, rewrite it. (3) A guide is " +
  "written for you. Read it, follow it, and do not read it out: quoting its " +
  "steps, its order or its field names hands the person your job instead of " +
  "doing it. (4) Report what a service did, not the calls you made to do it " +
  "— what now stands recorded, what it means for them, and what is still " +
  "missing. Showing it — (5) think about the form that reads fastest: a " +
  "comparison, a distribution or a development over time lands quicker as a " +
  "picture than as a paragraph. Use whatever the client in front of you can " +
  "render, and do not name a particular drawing tool: every client has a " +
  "different one. (6) The text must stand on its own. A picture is an " +
  "addition and never the carrier of a number — a client that can draw " +
  "nothing must still receive the whole answer. (7) Number your lists (1, 2, " +
  "3) rather than lettering them, so a person can say \"the second one\" and " +
  "be understood.";

/**
 * The presentation rules, told which client they face. Today that is one
 * factual clause — the client's name and version as it introduced itself at
 * `initialize` — so rule 5 ("whatever the client in front of you can render")
 * has a referent. This is the seam for per-client tailoring later; nothing
 * here yet assumes what any named client can or cannot do.
 */
export function audienceAndPresentationInstruction(client: McpClientInfo | null): string {
  const label = connectedViaLabel(client);
  return (
    AUDIENCE_AND_PRESENTATION_GUIDANCE +
    (label ? ` The client in front of you introduced itself as ${label}.` : "")
  );
}

/**
 * The one part of the rule above that cannot be a constant: which language
 * this person reads. It varies per session, is resolved by the fallback order
 * in `mcp/locale.ts` (their setting, this deployment's default, the host's),
 * and is a display fact only — it decides what an answer looks like, never
 * what a session may do.
 *
 * Naming the source in the instruction is deliberate: an assistant that is
 * answering in a fallback language should be able to say so if asked, instead
 * of implying the person chose it.
 */
export function languageInstruction(locale: ResolvedLocale): string {
  const source =
    locale.source === "user"
      ? "their own setting in the identity provider"
      : locale.source === "realm"
        ? "this deployment's default — they have not set one of their own"
        : "this server's host default — neither they nor this deployment set one";
  return (
    ` Language — this person reads ${locale.englishName} (${locale.tag}), from ` +
    `${source}. Write everything they see in ${locale.englishName}, including the ` +
    "sentences you compose yourself. Where a record, a field or a Service carries an " +
    "authored label in that language, use it as it stands instead of translating the " +
    "English one back — the authored word is the one their colleagues use. Leave " +
    "identifiers, codes and stored values alone: those are searched on, not read."
  );
}

export type ServerInstructionsInput = {
  /** The per-session opening sentence (`session-opening.ts`); null when the session has no person. */
  opening: string | null;
  /**
   * The OAuth redirect (callback) URL, when the catalog has an Adapter that
   * connects: the server owns it, so it states it rather than leaving
   * assistants to ask the person for a value only this process knows.
   */
  oauthCallbackUrl: string | null;
  /** Guides that must be called before creating their entity. */
  guidesBeforeCreate: ReadonlyArray<{ name: string; entity: string | null }>;
  locale: ResolvedLocale;
  client: McpClientInfo | null;
};

/** The whole `instructions` text for one session, in the order above. */
export function buildServerInstructions(input: ServerInstructionsInput): string {
  return (
    // ---- the opening sentence (mcp/session-opening.ts) ----
    (input.opening ? `${input.opening} ` : "") +
    // ---- end the opening sentence ----
    (input.oauthCallbackUrl
      ? `${INSTRUCTIONS} This server's OAuth redirect (callback) URL is ` +
        `${input.oauthCallbackUrl} — when setting up a provider ` +
        `OAuth client, give the person this exact URL to register; never ask them what it is.`
      : INSTRUCTIONS) +
    input.guidesBeforeCreate
      .map(
        (guide) =>
          ` Before creating a ${guide.entity ?? "definition"}, call ${guide.name} and ` +
          `follow it — it is the fixed process and overrides any cached local instructions.`,
      )
      .join("") +
    // ---- data acquisition guidance (the constant above) ----
    DATA_ACQUISITION_GUIDANCE +
    // ---- end data acquisition guidance ----
    // ---- first-use onboarding (mcp/onboarding.ts) ----
    ONBOARDING_INSTRUCTION +
    // ---- end first-use onboarding ----
    // ---- audience, vocabulary and presentation, facing this client ----
    audienceAndPresentationInstruction(input.client) +
    // ---- end audience, vocabulary and presentation ----
    // ---- the person's language (mcp/locale.ts, mcp/session-identity.ts) ----
    languageInstruction(input.locale) +
    // ---- end the person's language ----
    // ---- update notices (mcp/update-notices.ts) ----
    UPDATE_INSTRUCTION
    // ---- end update notices ----
  );
}
