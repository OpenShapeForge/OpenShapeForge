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
 * The verbs every CRUD Operation shares. A query of only these and an
 * unmatched subject ("create payroll") must not fall back to every create.
 */
const GENERIC_ACTION_WORDS = new Set([
  "create", "add", "list", "show", "get", "read", "find", "search", "update", "edit", "change", "delete", "remove",
  "aanmaken", "maak", "toevoegen", "voeg", "tonen", "toon", "lijst", "ophalen", "lezen", "zoek", "zoeken",
  "wijzigen", "wijzig", "bijwerken", "verwijderen", "verwijder",
]);

/**
 * A query word matches a text word that starts with its first five letters
 * (all of a shorter word): "invite" finds "invitation", "uitnodigen" finds
 * "uitnodiging", "organization" finds "organisatie", "role" finds "roles".
 * A plural also finds its singular: a text word of at least four letters
 * that the query word starts with matches too, so "roles" finds "role" but
 * "users" does not find "use". A word under three letters only matches
 * itself.
 */
function wordMatches(word: string, words: readonly string[]): boolean {
  if (word.length < 3) return words.includes(word);
  const prefix = word.slice(0, Math.min(5, word.length));
  return words.some((candidate) =>
    candidate.startsWith(prefix) ||
    (candidate.length >= 4 && candidate.length < word.length && word.startsWith(candidate)));
}

/**
 * What one query word is worth to one Operation: the words that name it (id,
 * key, entity, the entity's labels, the Operation name) count more than its
 * description, and the word itself more than a word it merely resembles.
 * Zero is no match.
 */
function wordScore(word: string, naming: readonly string[], describing: readonly string[]): number {
  if (naming.includes(word)) return 4;
  if (wordMatches(word, naming)) return 3;
  if (describing.includes(word)) return 2;
  return wordMatches(word, describing) ? 1 : 0;
}

/** The rank a query earns by being exactly an entity's name. */
const ENTITY_NAMED = 2;

/** The text that names one Operation: what a person or model would call it. */
type SearchText = Pick<RuntimeOperationDefinition, "name" | "description">;

/** Session-specific context of a search; none of it can widen `allowedIds`. */
export type OperationSearchContext = {
  /** Canonical text also matched on, for a definition whose shown text was replaced. */
  canonicalText?: ReadonlyMap<string, SearchText>;
  /** An entity's authored label per language, by entity name: "kennis" finds KnowledgeItem. */
  entityLabels?: ReadonlyMap<string, Readonly<Record<string, string>>>;
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
 * or nothing. A word query never does: every query word must match (any one
 * non-generic word when none matches them all), the matches are ranked by how
 * well the naming text fits, then by id, and paged as compact summaries by a
 * cursor that carries that position. The model reads the contract of the one
 * it chose by looking up its id.
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
  const candidates = available.map((definition) => {
    const canonical = input.canonicalText?.get(definition.id);
    const labels = definition.entityName ? input.entityLabels?.get(definition.entityName) : undefined;
    const naming = [definition.id, definition.key ?? "", definition.entityName ?? "", ...texts(labels), ...texts(definition.name), ...texts(canonical?.name)]
      .flatMap(words);
    const describing = [...texts(definition.description), ...texts(canonical?.description)].flatMap(words);
    const scores = query.map((word) => wordScore(word, naming, describing));
    // A query that is exactly an entity's name ("Template", "TemplateVariant")
    // ranks that entity's own Operations before others that merely contain it.
    const entityWords = words(definition.entityName ?? "");
    const namesEntity = query.length > 0 && entityWords.length === query.length && query.every((word) => entityWords.includes(word));
    return { definition, scores, score: scores.reduce((total, score) => total + score, 0) + (namesEntity ? ENTITY_NAMED : 0) };
  });
  // Every word, in any authored language, before any single word: a model
  // asks in its own words ("invite employee role"), not in one exact phrase
  // of the person's locale.
  const every = candidates.filter(({ scores }) => scores.every((score) => score > 0));
  const tier = every.length > 0 || query.length < 2 ? "every" : "some";
  const matched = (tier === "every"
    ? every
    : candidates
        .map((candidate) => {
          const scores = candidate.scores.map((score, index) =>
            query[index]!.length >= 3 && !GENERIC_ACTION_WORDS.has(query[index]!) ? score : 0);
          return { ...candidate, scores, score: scores.reduce((total, score) => total + score, 0) };
        })
        .filter(({ score }) => score > 0))
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
