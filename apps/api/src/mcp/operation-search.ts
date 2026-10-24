// SPDX-License-Identifier: BUSL-1.1
import type { RuntimeOperationDefinition } from "@openshapeforge/plugin-runtime";
import type { Tool } from "@modelcontextprotocol/server";
import {
  DEFAULT_OPERATION_SEARCH_RESULTS,
  MAX_OPERATION_SEARCH_RESULTS,
  compareCodeUnits,
  searchableOperationToolDefinitions,
  type SearchableOperationToolNames,
} from "@openshapeforge/operations";
import { createHash } from "node:crypto";
import { ENTITY_CONFIGURATION_APP_URI } from "./handoff-config.js";
import { HttpError } from "../rest/http-error.js";
import { localizedText, type ResolvedLocale } from "./locale.js";

export type { SearchableOperationToolNames } from "@openshapeforge/operations";

export type OperationSearchArguments =
  | { operationId: string }
  | { query?: string; cursor?: string; limit: number };

function objectInput(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "BAD_USER_INPUT", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(input).some((key) => !allowedSet.has(key))) {
    throw new HttpError(400, "BAD_USER_INPUT", `${label} contains an unknown property.`);
  }
}

export function canonicalRuntimeOperationSchema(
  value: Readonly<Record<string, unknown>>,
  operationId: string,
  side: "input" | "output",
): Record<string, unknown> {
  const schema = value.schema;
  if (
    value.kind !== "json-schema" ||
    !schema ||
    typeof schema !== "object" ||
    Array.isArray(schema)
  ) {
    throw new Error(
      `Runtime Operation ${JSON.stringify(operationId)} has no canonical JSON Schema ${side}.`,
    );
  }
  return structuredClone(schema as Record<string, unknown>);
}

export function runtimeOperationEnvelopeSchema(
  definition: RuntimeOperationDefinition,
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      data: canonicalRuntimeOperationSchema(
        definition.output,
        definition.id,
        "output",
      ),
      operations: { type: "array", items: { type: "object" } },
      resources: {
        type: "array",
        items: {
          type: "object",
          properties: {
            uri: { type: "string" },
            name: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            mimeType: { type: "string" },
          },
          required: ["uri", "name"],
          additionalProperties: false,
        },
      },
    },
    required: ["data", "operations"],
    additionalProperties: false,
  };
}

/** The searchable pair (shapes shared with the compiler's byte budget). */
export function searchableOperationTools(
  names: SearchableOperationToolNames,
): Tool[] {
  return searchableOperationToolDefinitions(names) as Tool[];
}

/** Only this narrowly scoped tool can mount the secure-input app. */
export function secureOperationTool(executor: Tool, name: string, operationIds: string[], appSupported: boolean): Tool {
  return {
    ...executor,
    name,
    title: "Enter secure Operation input",
    annotations: { ...executor.annotations, title: "Enter secure Operation input" },
    description: "Execute a canonical Operation declaring interaction.secureInput. Opens its private form when supported. Never pass secrets in input; enter them only in the private form. Use the ordinary executor for every other Operation.",
    inputSchema: {
      ...executor.inputSchema,
      properties: { ...executor.inputSchema.properties, operationId: { type: "string", enum: operationIds } },
    },
    ...(appSupported ? { _meta: { ui: { resourceUri: ENTITY_CONFIGURATION_APP_URI } } } : {}),
  };
}

export function assertOperationExecutionRoute(definition: RuntimeOperationDefinition, secureRoute: boolean, names: SearchableOperationToolNames): void {
  const requiresSecureInput = Boolean(definition.interaction?.secureInput);
  if (secureRoute !== requiresSecureInput) {
    throw new HttpError(400, "BAD_USER_INPUT", requiresSecureInput
      ? `Use ${names.secureExecute} for this Operation's private input form. Never send secrets through the ordinary executor.`
      : `Use ${names.execute} for this Operation; it does not need a private input form.`);
  }
}

export function parseOperationSearchArguments(value: unknown): OperationSearchArguments {
  const input = objectInput(value ?? {}, "Operation search input");
  rejectUnknownKeys(input, ["operationId", "query", "cursor", "limit"], "Operation search input");
  if (input.operationId !== undefined) {
    // The same identity rule the executor applies to its operationId.
    if (typeof input.operationId !== "string" || input.operationId.trim().length === 0) {
      throw new HttpError(400, "BAD_USER_INPUT", "A canonical Operation id is required.");
    }
    if (["query", "cursor", "limit"].some((key) => input[key] !== undefined)) {
      throw new HttpError(400, "BAD_USER_INPUT", "An operationId lookup takes no query, cursor or limit.");
    }
    return { operationId: input.operationId.trim() };
  }
  const query = input.query;
  const cursor = input.cursor;
  const limit = input.limit ?? DEFAULT_OPERATION_SEARCH_RESULTS;
  if (query !== undefined && (typeof query !== "string" || query.length > 200)) {
    throw new HttpError(400, "BAD_USER_INPUT", "Operation search query is invalid.");
  }
  if (
    cursor !== undefined &&
    (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 512)
  ) {
    throw new HttpError(400, "BAD_USER_INPUT", "Operation search cursor is invalid.");
  }
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_OPERATION_SEARCH_RESULTS
  ) {
    throw new HttpError(400, "BAD_USER_INPUT", "Operation search limit is invalid.");
  }
  return {
    ...(typeof query === "string" && query.trim() ? { query: query.trim() } : {}),
    ...(typeof cursor === "string" ? { cursor } : {}),
    limit,
  };
}

export function parseOperationExecuteArguments(value: unknown): {
  operationId: string;
  input: Record<string, unknown>;
  idempotencyKey?: string;
} {
  const args = objectInput(value, "Operation execution input");
  rejectUnknownKeys(
    args,
    ["operationId", "input", "idempotencyKey"],
    "Operation execution input",
  );
  if (typeof args.operationId !== "string" || args.operationId.trim().length === 0) {
    throw new HttpError(400, "BAD_USER_INPUT", "A canonical Operation id is required.");
  }
  const input = objectInput(args.input, "Operation input");
  if (
    args.idempotencyKey !== undefined &&
    (typeof args.idempotencyKey !== "string" ||
      args.idempotencyKey.length === 0 ||
      args.idempotencyKey.length > 512)
  ) {
    throw new HttpError(400, "BAD_USER_INPUT", "The idempotency key is invalid.");
  }
  return {
    operationId: args.operationId.trim(),
    input,
    ...(typeof args.idempotencyKey === "string"
      ? { idempotencyKey: args.idempotencyKey }
      : {}),
  };
}

/** Words a model adds around its intent that would match nearly every operation. */
const FILLER_WORDS = new Set([
  "a", "an", "the", "to", "of", "in", "on", "for", "with", "and", "or", "as", "by", "this", "that", "new",
  "de", "het", "een", "en", "of", "van", "voor", "met", "naar", "in", "op", "nieuw", "nieuwe",
]);

/** Text as words: camel case and separators like `.`, `_` and `-` split, lower-cased. */
function words(text: string): string[] {
  return text.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** The query's distinct words without filler ("TemplateVariant" is two words, like "template variant"). */
function queryWords(query: string | undefined): string[] {
  return [...new Set(words(query ?? "").filter((word) => !FILLER_WORDS.has(word)))];
}

/** Every authored language of a text. */
function texts(value: unknown): string[] {
  return typeof value === "string"
    ? [value]
    : value && typeof value === "object" && !Array.isArray(value)
      ? Object.values(value).filter((text): text is string => typeof text === "string")
      : [];
}

/**
 * The verbs every CRUD Operation shares, by the intents they ask for. They
 * say what to do, not what with: an Operation need not contain one to match
 * ("find person" finds a relation list), a query of only these and an
 * unmatched subject ("create payroll") must not fall back to every create,
 * and among equal matches they prefer the Operations of that intent.
 */
const ACTION_INTENTS: ReadonlyMap<string, readonly string[]> = new Map([
  ...["list", "show", "get", "read", "find", "search", "tonen", "toon", "lijst", "ophalen", "lezen", "zoek", "zoeken", "vind", "vinden"]
    .map((word): [string, readonly string[]] => [word, ["list", "get"]]),
  ...["create", "add", "aanmaken", "maak", "toevoegen", "voeg"].map((word): [string, readonly string[]] => [word, ["create"]]),
  ...["update", "edit", "change", "wijzigen", "wijzig", "bijwerken"].map((word): [string, readonly string[]] => [word, ["update"]]),
  ...["delete", "remove", "verwijderen", "verwijder"].map((word): [string, readonly string[]] => [word, ["delete"]]),
]);

/** Endings that only inflect a word ("persons", "roles", "personen", "relaties"). */
const INFLECTIONS = ["s", "es", "en", "n"];

/**
 * The same word, or the word inflected: a text word that is the query word
 * plus an inflection, or the other way around ("person" and "persons", "roles"
 * and "role"). A word under three letters only matches itself.
 */
function sameWord(word: string, candidate: string): boolean {
  if (word === candidate) return true;
  if (word.length < 3 || candidate.length < 3) return false;
  const [short, long] = word.length < candidate.length ? [word, candidate] : [candidate, word];
  return long.startsWith(short) && INFLECTIONS.includes(long.slice(short.length));
}

/**
 * A word it merely resembles: a text word sharing its first five letters (all
 * of a shorter word) — "invite" finds "invitation", "uitnodigen" finds
 * "uitnodiging", "organization" finds "organisatie" — a text word of at least
 * four letters the query word starts with ("users" does not find "use"), or a
 * compound ending in a query word of at least four letters ("naam" in
 * "weergavenaam"). Weaker than the word itself: "person" resembles
 * "personal" but is not it.
 */
function resembles(word: string, candidate: string): boolean {
  if (word.length < 3) return false;
  return candidate.startsWith(word.slice(0, Math.min(5, word.length))) ||
    (candidate.length >= 4 && candidate.length < word.length && word.startsWith(candidate)) ||
    (word.length >= 4 && candidate.length > word.length && candidate.endsWith(word));
}

/** What a query word earns by being a word that names the Operation (its best match). */
const NAMED = 8;

/** The text of one Operation a query word can match, from strongest to weakest. */
type MatchText = { naming: readonly string[]; describing: readonly string[]; context: readonly string[] };

/**
 * What one query word is worth to one Operation. The word itself (sameWord)
 * counts more than a word it merely resembles (resembles), wherever it
 * occurs: the word in a description, even in a field label, outranks a name
 * that only shares a prefix ("person" is not "personal"). The words that name
 * the Operation (id, key, entity, the entity's labels, the Operation name)
 * count more than its description, and the description more than its
 * entity's field labels. Zero is no match.
 */
function wordScore(word: string, text: MatchText): number {
  const same = (list: readonly string[]) => list.some((candidate) => sameWord(word, candidate));
  const like = (list: readonly string[]) => list.some((candidate) => resembles(word, candidate));
  if (same(text.naming)) return NAMED;
  if (same(text.describing)) return 5;
  if (same(text.context)) return 3;
  if (like(text.naming)) return 2;
  return like(text.describing) || like(text.context) ? 1 : 0;
}

/**
 * How much a query word tells apart: a word few available Operations match
 * ("person") weighs more than one nearly all of them match ("name"). Computed
 * over this session's own Operations, so no word or entity is special.
 */
function wordWeight(matching: number, available: number): number {
  return 1 + Math.log(available / Math.max(matching, 1));
}

/** The rank a match of every query word earns over any match of only some (more than any word sum). */
const EVERY_WORD = 10_000;

/** Ranks are compared as integers (the cursor carries one): this many steps per score point. */
const RANK_STEPS = 1_000;

/** The rank a query earns by being exactly an entity's name. */
const ENTITY_NAMED = 4;

/**
 * What a query verb is worth to an Operation of the intent it asks for ("find"
 * asks to read): a verb is matched by the intent, as fully as a word that
 * names the Operation, and weighted like any other word (wordWeight).
 */
const ASKED_INTENT = 8;

/** The text that names one Operation: what a person or model would call it. */
type SearchText = Pick<RuntimeOperationDefinition, "name" | "description">;

/** Session-specific context of a search; none of it can widen `allowedIds`. */
export type OperationSearchContext = {
  /** Canonical text also matched on, for a definition whose shown text was replaced. */
  canonicalText?: ReadonlyMap<string, SearchText>;
  /** An entity's authored label per language, by entity name: "kennis" finds KnowledgeItem. */
  entityLabels?: ReadonlyMap<string, Readonly<Record<string, string>>>;
  /**
   * The labels, in every authored language, of the fields a session sees of
   * an entity, by entity name: a relation's "Display name" and "Natural
   * persons" make "find person by name" a relation lookup.
   */
  entityFields?: ReadonlyMap<string, readonly string[]>;
  /**
   * The canonical id another exact name stands for (a generated tool name),
   * or undefined. Only an id that is itself available is ever answered.
   */
  resolveName?: (name: string) => string | undefined;
};

/**
 * The available Operation an explicit lookup names: the canonical id itself,
 * or the id the existing exact generated-name matcher resolves the name to.
 * Ids compare exactly (two ids differing only in case are two Operations),
 * and only an available id answers; nothing says whether it exists elsewhere.
 */
function lookup(
  available: readonly RuntimeOperationDefinition[],
  operationId: string,
  resolveName: ((name: string) => string | undefined) | undefined,
): RuntimeOperationDefinition | undefined {
  const exact = available.find((definition) => definition.id === operationId);
  if (exact) return exact;
  const resolved = resolveName?.(operationId);
  return resolved === undefined ? undefined : available.find((definition) => definition.id === resolved);
}

type SearchCursor = { v: 1; q: string; s: number; id: string };

/** The query a cursor belongs to: its normalized words. */
function queryFingerprint(words: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(words)).digest("base64url").slice(0, 16);
}

function encodeCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string, fingerprint: string): SearchCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    parsed = undefined;
  }
  const cursor = parsed as Partial<SearchCursor> | undefined;
  if (
    !cursor || typeof cursor !== "object" || Object.keys(cursor).length !== 4 || cursor.v !== 1 ||
    typeof cursor.q !== "string" || !Number.isInteger(cursor.s) || cursor.s! < 0 ||
    typeof cursor.id !== "string" || cursor.id.length === 0
  ) {
    throw new HttpError(400, "BAD_USER_INPUT", "Operation search cursor is invalid.");
  }
  if (cursor.q !== fingerprint) {
    throw new HttpError(400, "BAD_USER_INPUT", "Operation search cursor belongs to a different query.");
  }
  return cursor as SearchCursor;
}

/** The complete current contract of one Operation, as the executor validates it. */
function operationContract(definition: RuntimeOperationDefinition, name: string, description: string): Record<string, unknown> {
  return {
    ...operationSummary(definition, name, description),
    inputSchema: canonicalRuntimeOperationSchema(definition.input, definition.id, "input"),
    outputSchema: canonicalRuntimeOperationSchema(definition.output, definition.id, "output"),
    // The declared failure catalogue: in searchable mode this result is the
    // only description of the operation the model ever reads.
    ...(definition.errors ? { errors: structuredClone(definition.errors) } : {}),
    ...(definition.concurrency
      ? { concurrency: structuredClone(definition.concurrency) }
      : {}),
    ...(definition.interaction
      ? { interaction: structuredClone(definition.interaction) }
      : {}),
    ...(definition.prerequisites
      ? { prerequisites: structuredClone(definition.prerequisites) }
      : {}),
  };
}

/**
 * What tells several candidates apart: identity, wording, scope and declared
 * effects. No schema — reading the chosen id's contract is one exact search.
 */
function operationSummary(definition: RuntimeOperationDefinition, name: string, description: string): Record<string, unknown> {
  return {
    operation: { id: definition.id, intent: definition.intent },
    ...(definition.key ? { key: definition.key } : {}),
    ...(definition.entityId ? { entityId: definition.entityId } : {}),
    ...(definition.entityName ? { entityName: definition.entityName } : {}),
    name,
    description,
    ...(definition.target ? { target: structuredClone(definition.target) } : {}),
    effects: structuredClone(definition.effects),
    reliability: structuredClone(definition.reliability),
  };
}

/**
 * Search the session's available Operations, or look one up.
 *
 * `operationId` answers that one available Operation with its full contract,
 * or nothing. A word query never does: the Operations matching every query
 * word (a verb also by the intent it asks for) come first, then those a
 * subject word names (any subject word when nothing matches them all); each
 * group is ranked by how well each word
 * matches (wordScore) weighted by how much that word tells apart
 * (wordWeight), then by id, and paged as compact summaries by a cursor that
 * carries that position. The model reads the contract of the one it
 * chose by looking up its id.
 */
export function searchOperationDefinitions(input: {
  definitions: readonly RuntimeOperationDefinition[];
  allowedIds: ReadonlySet<string>;
  arguments: unknown;
  locale: ResolvedLocale;
} & OperationSearchContext): { operations: Record<string, unknown>[]; nextCursor?: string } {
  const args = parseOperationSearchArguments(input.arguments);
  const available = input.definitions.filter((definition) => input.allowedIds.has(definition.id));
  const shown = (definition: RuntimeOperationDefinition) => {
    const name = localizedText(definition.name, input.locale) ?? definition.id;
    return { name, description: localizedText(definition.description, input.locale) ?? name };
  };
  if ("operationId" in args) {
    const found = lookup(available, args.operationId, input.resolveName);
    if (!found) return { operations: [] };
    const { name, description } = shown(found);
    return { operations: [operationContract(found, name, description)] };
  }
  const query = queryWords(args.query);
  // A verb ("find", "zoek") says what to do with the subject; a query of only
  // verbs matches them as plain words.
  const isSubject = query.map((word) => !ACTION_INTENTS.has(word));
  const verbsOnly = !isSubject.includes(true);
  const scored = available.map((definition) => {
    const canonical = input.canonicalText?.get(definition.id);
    const labels = definition.entityName ? input.entityLabels?.get(definition.entityName) : undefined;
    const text: MatchText = {
      naming: [definition.id, definition.key ?? "", definition.entityName ?? "", ...texts(labels), ...texts(definition.name), ...texts(canonical?.name)]
        .flatMap(words),
      describing: [...texts(definition.description), ...texts(canonical?.description)].flatMap(words),
      context: (definition.entityName ? input.entityFields?.get(definition.entityName) ?? [] : []).flatMap(words),
    };
    // A verb also matches an Operation of the intent it asks for, as fully
    // as a word that names it.
    return { definition, scores: query.map((word, index) => Math.max(wordScore(word, text),
      !verbsOnly && !isSubject[index] && ACTION_INTENTS.get(word)!.includes(definition.intent) ? ASKED_INTENT : 0)) };
  });
  const weights = query.map((_, index) =>
    wordWeight(scored.filter(({ scores }) => scores[index]! > 0).length, available.length));
  // Every word, in any authored language, before any single word: a model
  // asks in its own words ("invite employee role"), not in one exact phrase
  // of the person's locale. After those, an Operation a subject word of three
  // or more letters names itself, so one word the model added ("contact
  // details of a person") cannot hide the entity it names. When nothing
  // matches every word, any subject word finds candidates — never a verb alone.
  // A partial match counts its subject words of three or more letters, and
  // still the verbs' intent (which alone never makes a candidate).
  const subjectHit = (scores: number[], at: number) => isSubject[at] && query[at]!.length >= 3 ? scores[at]! : 0;
  const partial = (scores: number[]) => scores.map((score, index) => isSubject[index] ? subjectHit(scores, index) : score);
  const every = scored.filter(({ scores }) => scores.every((score) => score > 0));
  const matched = (every.length > 0 || query.length < 2
    ? [
        ...every.map((entry) => ({ ...entry, every: query.length > 0 })),
        ...scored
          .filter(({ scores }) => query.length >= 2 && !scores.every((score) => score > 0) && scores.some((_, index) => subjectHit(scores, index) === NAMED))
          .map(({ definition, scores }) => ({ definition, scores: partial(scores), every: false })),
      ]
    : scored
        .filter(({ scores }) => scores.some((_, index) => subjectHit(scores, index) > 0))
        .map(({ definition, scores }) => ({ definition, scores: partial(scores), every: false })))
    .map(({ definition, every, scores }) => {
      // A query that is exactly an entity's name ("Template", "TemplateVariant")
      // ranks that entity's own Operations before others that merely contain it.
      const entityWords = words(definition.entityName ?? "");
      const namesEntity = query.length > 0 && entityWords.length === query.length && query.every((word) => entityWords.includes(word));
      const rank = (every ? EVERY_WORD : 0) +
        scores.reduce((total, score, index) => total + score * weights[index]!, 0) + (namesEntity ? ENTITY_NAMED : 0);
      return { definition, score: Math.round(rank * RANK_STEPS) };
    })
    // Rank, then id. The sort and the cursor comparison below must be the
    // same total order, and ids compare by code unit (compareCodeUnits): a
    // collation-sorted list loops and skips.
    .sort((left, right) => right.score - left.score || compareCodeUnits(left.definition.id, right.definition.id));
  const fingerprint = queryFingerprint(query);
  const after = args.cursor ? decodeCursor(args.cursor, fingerprint) : undefined;
  // A cursor names the last entry of the previous page. One that names no
  // entry of this result (an edited cursor, or an Operation no longer here)
  // is refused rather than silently skipping or repeating matches.
  const anchor = after
    ? matched.findIndex(({ score, definition }) => score === after.s && definition.id === after.id)
    : -1;
  if (after && anchor < 0) {
    throw new HttpError(400, "BAD_USER_INPUT", "Operation search cursor no longer matches this result; search again.");
  }
  const start = after ? anchor + 1 : 0;
  const page = matched.slice(start, start + args.limit);
  const end = start + page.length;
  const last = page.at(-1);
  return {
    operations: page.map(({ definition }) => {
      const { name, description } = shown(definition);
      return operationSummary(definition, name, description);
    }),
    ...(end < matched.length && last
      ? { nextCursor: encodeCursor({ v: 1, q: fingerprint, s: last.score, id: last.definition.id }) }
      : {}),
  };
}
