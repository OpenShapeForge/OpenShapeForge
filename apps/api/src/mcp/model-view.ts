// SPDX-License-Identifier: BUSL-1.1
/**
 * What the searchable executor and the Operation search hand a MODEL, as
 * opposed to a renderer.
 *
 * The canonical envelope and contract are written for every interface at
 * once: a list page repeats each record's Operation offers on every row, with
 * the row's id and version bound in, and a schema carries the presentation
 * and translation annotations a form needs. A model reads all of it as text,
 * on every call. Measured on thirty ordinary requests, that repetition was
 * more than half of every list row, pages outgrew the client's result limit
 * and were re-requested in ever smaller pieces, and each contract cost a
 * round of its own.
 *
 * Nothing here changes an Operation, what it accepts, or the shape it
 * declares: every result still satisfies its Operation's output schema. A
 * row keeps the offers that say something about that row (an Operation that
 * is not available on it, an offer bound to more than its id) and leaves out
 * the ones every row has, which the search already answers; a field without
 * a value is left out; a schema keeps what the executor validates.
 */

/** The largest result text a page may reach before it is requested smaller. */
export const MODEL_RESULT_CHARACTERS = 40_000;

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * A schema as the executor validates it: every validation keyword and
 * description, without the `x-osf-*` annotations (presentation, translations,
 * reference metadata) and without `title`, which repeats the property name.
 */
export function modelSchema<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map((entry) => modelSchema(entry)) as T;
  if (!isObject(schema)) return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !key.startsWith("x-osf") && key !== "title")
      .map(([key, value]) => [key, modelSchema(value)]),
  ) as T;
}

/** A summary states what an Operation is for; its full text is in the contract. */
export function summaryDescription(description: string, limit = 240): string {
  if (description.length <= limit) return description;
  const cut = description.slice(0, limit);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"));
  return `${sentence > limit / 3 ? cut.slice(0, sentence + 1) : `${cut.slice(0, cut.lastIndexOf(" "))}`} …`;
}

type Offer = {
  operation: { id: string; intent: string };
  available?: boolean;
  concurrency?: unknown;
  error?: { data?: unknown; [key: string]: unknown };
  binding?: { target?: { id?: string; version?: string }; input?: JsonObject };
  [key: string]: unknown;
};

type RecordPage = { data: { items: Array<{ data: JsonObject; operations?: Offer[] }> } & JsonObject; operations?: unknown };

/** Whether an offer's binding only repeats the record it is offered on: its id, in one input. */
function bindsOnlyItsRecord(offer: Offer, recordId: unknown): boolean {
  const entries = Object.entries(offer.binding?.input ?? {});
  return entries.length === 1 && entries[0]![1] === recordId;
}

function selectFields(row: JsonObject, fields: readonly string[] | undefined): JsonObject {
  const selected = fields ? new Set(["id", ...fields]) : undefined;
  return Object.fromEntries(
    Object.entries(row).filter(([key, value]) => value !== null && (!selected || selected.has(key))),
  );
}

/** Whether an executor result is the canonical page of an entity list. */
export function isRecordPage(payload: unknown): payload is RecordPage {
  return isObject(payload) && isObject(payload.data) && Array.isArray(payload.data.items) &&
    payload.data.items.every((item) => isObject(item) && isObject(item.data));
}

/**
 * A list page for a model: the same page, in the same shape. A row keeps the
 * offers that are about that row — an Operation that is not available on it,
 * with the reason, and an offer bound to more than its id — and not the
 * available ones every row repeats with nothing but its own id and version
 * bound in: what can be done with a record of this kind is what the search
 * answers. A field without a value is left out of a row.
 */
export function modelRecordPage(payload: RecordPage, fields?: readonly string[]): JsonObject {
  return {
    ...payload,
    data: {
      ...payload.data,
      items: payload.data.items.map((item) => ({
        data: selectFields(item.data, fields),
        operations: (item.operations ?? [])
          .filter((offer) => offer.available === false || (offer.binding !== undefined && !bindsOnlyItsRecord(offer, item.data.id)))
          .map(withoutTranslations),
      })),
    },
  };
}

/** A refusal's reason as its code and message: the translations of the same sentence are for a renderer. */
function withoutTranslations(offer: Offer): Offer {
  if (!offer.error || !("data" in offer.error)) return offer;
  const { data: _data, ...error } = offer.error;
  return { ...offer, error };
}

/**
 * One record for a model: its offers without the binding that only repeats
 * the record's own id and version. A single record keeps its empty fields:
 * an update needs to see what exists.
 */
export function modelRecord(payload: unknown, fields?: readonly string[]): unknown {
  if (!isObject(payload) || !isObject(payload.data) || typeof payload.data.id !== "string" || !Array.isArray(payload.operations)) return payload;
  const record = payload.data;
  const operations = (payload.operations as Offer[]).map((offer) => {
    if (!offer.binding || !bindsOnlyItsRecord(offer, record.id)) return offer;
    const { binding: _binding, ...rest } = offer;
    return rest;
  });
  return { ...payload, data: fields ? selectFields(record, fields) : record, operations };
}

/**
 * A list page that stays readable. A page larger than the limit is requested
 * again with as many records as fit, so the cursor it answers with is the
 * engine's own: a client refuses a result that is too large, and the model
 * would then ask again blind, in ever smaller pieces.
 */
export async function fittingRecordPage(
  payload: RecordPage,
  options: { fields?: readonly string[]; limit?: number; refetch: (first: number) => Promise<unknown> },
): Promise<JsonObject> {
  const limit = options.limit ?? MODEL_RESULT_CHARACTERS;
  const page = modelRecordPage(payload, options.fields);
  const size = JSON.stringify(page).length;
  const rows = payload.data.items.length;
  if (size <= limit || rows <= 1) return page;
  const fitting = Math.max(1, Math.floor(rows * (limit / size) * 0.9));
  const smaller = await options.refetch(fitting);
  // The smaller page says where it ends itself: its nextCursor continues from there.
  return isRecordPage(smaller) ? modelRecordPage(smaller, options.fields) : page;
}

/**
 * The field selection of a record read: only the named fields of each record,
 * with its id. A selection sent inside `input` is taken as meant, since no
 * record read has such an input. A model guesses a name now and then ("name"
 * for a display name): a selection that names a field the record does not
 * have is not applied, so the records come whole and show the names that
 * exist. Refusing it would cost the round the selection was meant to save;
 * leaving the name out silently would read as an empty field.
 */
export function recordFieldSelection(
  parsed: { input: JsonObject; fields?: readonly string[] },
  entity: { fields?: readonly string[] | undefined; read: boolean },
): { input: JsonObject; fields?: string[] } {
  const { fields: nested, ...input } = parsed.input;
  const misplaced = entity.read && parsed.fields === undefined && Array.isArray(nested) && nested.length > 0 &&
    nested.every((field) => typeof field === "string");
  const asked = parsed.fields ?? (misplaced ? nested as string[] : undefined);
  if (!asked) return { input: parsed.input };
  const known = !entity.fields || asked.every((field) => entity.fields!.includes(field));
  return { input: misplaced ? input : parsed.input, ...(known ? { fields: [...asked] } : {}) };
}
