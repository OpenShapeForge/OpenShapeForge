// SPDX-License-Identifier: BUSL-1.1
/**
 * A definition's process variables: what an author may declare, and what they
 * may seed it with.
 *
 * `processVariables` and `processVariableInitializers` are two top-level keys on
 * the definition document. Until this module nothing in this repo wrote them —
 * `toStoredGraph` carried them through by its spread, along with every other key
 * the designer does not understand — so the guarantee in
 * `graph/canvas-graph.ts` held for them for free. It does not any more, and the
 * whole shape of this file follows from keeping it anyway:
 *
 * **Every operation returns the value it was GIVEN when nothing changed, and
 * every operation that changes one entry SPREADS the stored entry rather than
 * rebuilding it.** The first is what lets `toStoredGraph` compare by reference
 * and write nothing for an untouched document; the second is what stops an edit
 * to a variable's label deleting the `semanticType`, `hints` or `authoring`
 * block somebody else's tooling put on it.
 *
 * Pure, and here rather than in a component, for the reason everything else in
 * this folder is: `apps/web` has no test runner, so a rule that can be wrong
 * lives where `bun test examples` reaches it.
 *
 * ## What the engine actually consumes
 *
 * From `runtime/command-runtime.ts` (`initializeProcessVariables`) and
 * `runtime/process-runtime.ts`, and this editor may not offer a shape outside
 * it:
 *
 * - **The declared set is closed.** A run's variables are exactly the keys
 *   `processVariables` declares. An initializer naming anything else is
 *   dropped, a caller's override for anything else is dropped, and a bridge's
 *   `processOutputMappings` targeting anything else is dropped. So deleting a
 *   declaration has to take its initializer with it, or the document keeps a
 *   line nothing will ever read.
 * - **A declaration is keyed by `key`**, trimmed; an entry without one is
 *   skipped entirely by the engine.
 * - **Seeding is three layers**: the declaration's own `value ?? defaultValue`,
 *   then an initializer targeting it, then the start command's overrides. The
 *   first two are resolved as placeholders, so `{{input.x}}` in either is a
 *   real thing to write and the editor must not escape it.
 * - **Order is semantic.** Declarations are seeded in document order against a
 *   variable bag that is filled as it goes, so a later default may read an
 *   earlier variable through `{{process.…}}`. Re-sorting this list would change
 *   what a run starts with, which is why {@link moveProcessVariable} exists and
 *   why nothing here sorts.
 * - **A key is a path segment.** `{{process.<key>}}` is split on `.` and `[n]`
 *   by the runtime, and `field-definitions.ts` refuses a key containing a dot
 *   outright. See {@link checkProcessVariableKey}.
 *
 * ## Renaming a key is deliberately not offered
 *
 * A key is referenced by `{{process.<key>}}` inside any node's config, by a
 * node's `processOutputMappings[].targetKey`, and by a node's
 * `processVariableKeys`. Renaming without rewriting all three leaves a graph
 * that publishes and then fails at run time on UNRESOLVED_VARIABLE, and
 * rewriting them means editing config this module has no business rewriting —
 * a `{{process.x}}` inside a free-text template is not distinguishable from one
 * an author meant literally. So a rename is a delete and an add, exactly as
 * changing a node's type is; see `graph/canvas-graph.ts`'s note on `type`.
 */

/** The two lists, as the document holds them. Held by reference; see the header. */
export type ProcessVariableSet = {
  /** `processVariables`, verbatim. Entries are not required to be usable. */
  readonly fields: readonly unknown[];
  /** `processVariableInitializers`, verbatim. */
  readonly initializers: readonly unknown[];
};

/**
 * Shared, so a document with no variables yields one value rather than an
 * allocation per read — which is what keeps `readProcessVariableSet` stable
 * enough to compare by reference.
 */
const NO_ENTRIES: readonly unknown[] = Object.freeze([]);

export const EMPTY_PROCESS_VARIABLE_SET: ProcessVariableSet = Object.freeze({
  fields: NO_ENTRIES,
  initializers: NO_ENTRIES,
});

/**
 * The value types a declaration may carry, which is the authoring field
 * contract's own list (`FieldDefinitionValueType`).
 *
 * Constrained because the declaration doubles as a field definition: when a
 * node config binds `{{process.<key>}}` through a `kind: "variable"` source,
 * `runtime/field-definitions.ts` merges this record into the field the renderer
 * draws. A `valueType` outside the contract produces a field nothing can
 * render.
 */
export const PROCESS_VARIABLE_VALUE_TYPES = [
  "string",
  "integer",
  "number",
  "boolean",
  "date",
  "datetime",
  "object",
] as const;

export type ProcessVariableValueType = (typeof PROCESS_VARIABLE_VALUE_TYPES)[number];

/** One declared variable, as a screen shows it. Never what gets stored. */
export type ProcessVariableView = {
  key: string;
  /** The label for the requested locale, falling back to the key. */
  label: string;
  valueType: ProcessVariableValueType;
  description: string | null;
  /**
   * The initializer's value when it is text, so an input can hold it. Empty
   * when there is no initializer, and when there is one this editor will not
   * touch — see {@link startValueIsOpaque}.
   */
  startValue: string;
  /**
   * Set when an initializer exists whose value is not text: a number, a list,
   * an object. Shown rather than edited, because flattening one into a text box
   * would rewrite it on the first keystroke and on every save after that.
   */
  startValueIsOpaque: boolean;
};

/** Why a key was refused. Codes, worded by whatever surface reports them. */
export type ProcessVariableKeyRefusal =
  /** Blank, or nothing but whitespace. */
  | "EMPTY"
  /**
   * Holds something a runtime path cannot carry. `{{process.<key>}}` is split
   * on `.` and `[n]`, and `field-definitions.ts` refuses a dotted key outright,
   * so a key is restricted to letters, digits, `_` and `-`.
   */
  | "ILLEGAL"
  /** Another declaration already uses it. The engine's set is keyed, not ordered. */
  | "DUPLICATE";

export type ProcessVariableKeyCheck =
  | { ok: true; key: string }
  | { ok: false; refusal: ProcessVariableKeyRefusal };

/** Letters, digits, `_` and `-`. See {@link ProcessVariableKeyRefusal}. */
const LEGAL_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * Whether a key may be declared, and the trimmed form to declare it under.
 *
 * One rule rather than two, because adding a variable and importing one both
 * ask it. The engine trims, so this trims; a key that only differs from
 * another by surrounding space is the same key to a run and is refused here as
 * a duplicate rather than accepted and then silently merged.
 */
export function checkProcessVariableKey(input: {
  key: string;
  /** Keys already declared. Compared trimmed, as the engine reads them. */
  taken?: readonly string[];
}): ProcessVariableKeyCheck {
  const key = input.key.trim();
  if (key.length === 0) return { ok: false, refusal: "EMPTY" };
  if (!LEGAL_KEY.test(key)) return { ok: false, refusal: "ILLEGAL" };
  const taken = (input.taken ?? []).map((entry) => entry.trim());
  if (taken.includes(key)) return { ok: false, refusal: "DUPLICATE" };
  return { ok: true, key };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The two lists off a stored graph, BY REFERENCE.
 *
 * By reference is the whole point: `toStoredGraph` decides whether to write
 * either key by comparing what it is handed against what this returned, exactly
 * as it does for a node's `config`. A normalising read would present every
 * document as edited and write both keys on every save.
 *
 * A value that is not an array yields the shared empty list, which compares
 * equal to itself and therefore still writes nothing — the malformed value
 * survives on the spread, as it does everywhere else in this adapter.
 */
export function readProcessVariableSet(graph: unknown): ProcessVariableSet {
  const record = asRecord(graph);
  const fields = record.processVariables;
  const initializers = record.processVariableInitializers;
  if (!Array.isArray(fields) && !Array.isArray(initializers)) {
    return EMPTY_PROCESS_VARIABLE_SET;
  }
  return {
    fields: Array.isArray(fields) ? (fields as readonly unknown[]) : NO_ENTRIES,
    initializers: Array.isArray(initializers)
      ? (initializers as readonly unknown[])
      : NO_ENTRIES,
  };
}

/** The declared keys, in document order, skipping entries the engine skips. */
export function processVariableKeys(set: ProcessVariableSet): string[] {
  return set.fields.flatMap((entry) => {
    const key = asString(asRecord(entry).key);
    return key ? [key] : [];
  });
}

/**
 * The declarations a screen can show, in document order.
 *
 * Entries the engine skips — not an object, or carrying no usable `key` — are
 * left out of the VIEW and never out of the document; see
 * {@link setProcessVariableField} for how an edit to one declaration leaves the
 * rest of the list exactly where it was.
 *
 * A duplicate key is shown once. It is the engine's own reading: seeding walks
 * the list in order and the last write to a key wins, so a second declaration
 * of `total` is not a second variable. Showing both would offer two rows that
 * edit one value.
 */
export function describeProcessVariables(
  set: ProcessVariableSet,
  options: { locale?: string } = {},
): ProcessVariableView[] {
  const initializers = initializersByKey(set);
  const views: ProcessVariableView[] = [];
  const seen = new Set<string>();

  for (const entry of set.fields) {
    const record = asRecord(entry);
    const key = asString(record.key);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const initializer = initializers.get(key);
    const hasText = typeof initializer === "string";
    views.push({
      key,
      label: localized(record.label, options.locale ?? "en") ?? key,
      valueType: asValueType(record.valueType),
      description: localized(record.description, options.locale ?? "en"),
      startValue: hasText ? (initializer as string) : "",
      startValueIsOpaque: initializer !== undefined && !hasText,
    });
  }

  return views;
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

export type AddProcessVariableInput = {
  key: string;
  valueType?: ProcessVariableValueType;
  /** What to show it as. Written as a locale map, which is what a field is. */
  label?: string;
  locale?: string;
};

/**
 * Declare a variable, or say why not.
 *
 * Appended rather than inserted, because order is seeding order and a new
 * variable can read every earlier one but nothing can read it yet.
 *
 * The record written is minimal — `key`, `valueType`, and a `label` only when
 * one was given. A blank label is left absent rather than written as `""`: the
 * difference is visible to every reader that falls back to the key, and to a
 * document diff.
 */
export function addProcessVariable(
  set: ProcessVariableSet,
  input: AddProcessVariableInput,
): { set: ProcessVariableSet; refused: ProcessVariableKeyRefusal | null } {
  const checked = checkProcessVariableKey({
    key: input.key,
    taken: processVariableKeys(set),
  });
  if (!checked.ok) return { set, refused: checked.refusal };

  const locale = input.locale ?? "en";
  const label = input.label?.trim();
  const declared: Record<string, unknown> = {
    key: checked.key,
    valueType: input.valueType ?? "string",
    ...(label ? { label: { [locale]: label } } : {}),
  };

  return {
    set: { fields: [...set.fields, declared], initializers: set.initializers },
    refused: null,
  };
}

/**
 * Change one property of one declaration.
 *
 * The stored entry is SPREAD, so every key this editor does not model —
 * `semanticType`, `hints`, `authoring`, `validation`, whatever a future
 * authoring pass adds — comes back untouched. Only the named property is
 * assigned, and assigning the value it already holds returns the set that was
 * given so the edit costs no undo entry and no save.
 *
 * `label` and `description` are locale maps, so they are merged into whatever
 * map is stored rather than replacing it: an author editing the English label
 * of a variable authored in two languages must not delete the other one.
 * Clearing one removes that locale, which is what "no English label" is; a map
 * left with nothing in it is removed entirely.
 */
export function setProcessVariableField(
  set: ProcessVariableSet,
  input: {
    key: string;
    property: "label" | "description" | "valueType";
    value: string;
    locale?: string;
  },
): ProcessVariableSet {
  let changed = false;
  const fields = set.fields.map((entry) => {
    const record = asRecord(entry);
    if (asString(record.key) !== input.key.trim()) return entry;

    const next =
      input.property === "valueType"
        ? assignValueType(record, input.value)
        : assignLocalized(record, input.property, input.value, input.locale ?? "en");
    if (next === null) return entry;
    changed = true;
    return next;
  });

  return changed ? { fields, initializers: set.initializers } : set;
}

/**
 * Set a variable's start value, as the initializer targeting it.
 *
 * Blank REMOVES the initializer rather than storing `""`, because the two are
 * different runs: no initializer leaves the declaration's own
 * `value ?? defaultValue` standing, and an empty one overwrites it with an
 * empty string. A text box that could only express the second would make the
 * first unreachable once an author had typed in it.
 *
 * An initializer whose stored value is not text is left alone — see
 * {@link ProcessVariableView.startValueIsOpaque}. A caller that shows it
 * read-only never reaches this; a caller that does not gets a no-op rather than
 * a silent overwrite.
 *
 * Nothing is written for a key that is not declared. The engine drops those,
 * so writing one would put a line in the document that can never do anything.
 */
export function setProcessVariableStartValue(
  set: ProcessVariableSet,
  input: { key: string; value: string },
): ProcessVariableSet {
  const key = input.key.trim();
  if (!processVariableKeys(set).includes(key)) return set;

  const current = initializersByKey(set).get(key);
  if (current !== undefined && typeof current !== "string") return set;

  const value = input.value;
  const wanted = value.trim().length > 0 ? value : undefined;
  if (current === wanted) return set;

  if (wanted === undefined) {
    return {
      fields: set.fields,
      initializers: set.initializers.filter(
        (entry) => asString(asRecord(entry).targetKey) !== key,
      ),
    };
  }

  let replaced = false;
  const initializers = set.initializers.map((entry) => {
    if (asString(asRecord(entry).targetKey) !== key) return entry;
    replaced = true;
    // Spread, for the same reason a declaration is: an initializer may carry
    // keys this editor has never heard of.
    return { ...asRecord(entry), value: wanted };
  });

  return {
    fields: set.fields,
    initializers: replaced ? initializers : [...set.initializers, { targetKey: key, value: wanted }],
  };
}

/**
 * Undeclare a variable, and drop the initializer that targeted it.
 *
 * Both halves, because the engine's declared set is closed: an initializer for
 * an undeclared key is skipped, so leaving it behind stores a line that can
 * never run and that would silently come back to life if the key were declared
 * again later.
 *
 * References to it in node config are deliberately NOT swept. They are
 * `{{process.<key>}}` inside free text this module cannot safely rewrite, and
 * validation is where an author is told about them.
 */
export function removeProcessVariable(
  set: ProcessVariableSet,
  key: string,
): ProcessVariableSet {
  const wanted = key.trim();
  const fields = set.fields.filter((entry) => asString(asRecord(entry).key) !== wanted);
  if (fields.length === set.fields.length) return set;
  return {
    fields,
    initializers: set.initializers.filter(
      (entry) => asString(asRecord(entry).targetKey) !== wanted,
    ),
  };
}

/**
 * Move a declaration one place earlier or later.
 *
 * Order is seeding order — a declaration's default is resolved against the
 * variables already seeded — so this is a real edit and not a display
 * preference. Moving past an unusable entry keeps that entry where it is: it is
 * not a row anybody can see, and swapping with it would look like nothing
 * happened.
 *
 * At either end this returns the set it was given, so the button that produced
 * it costs no undo entry.
 */
export function moveProcessVariable(
  set: ProcessVariableSet,
  input: { key: string; direction: "up" | "down" },
): ProcessVariableSet {
  const wanted = input.key.trim();
  const positions = set.fields.flatMap((entry, index) =>
    asString(asRecord(entry).key) === null ? [] : [index],
  );
  const at = positions.findIndex(
    (index) => asString(asRecord(set.fields[index]).key) === wanted,
  );
  if (at < 0) return set;

  const swapWith = input.direction === "up" ? at - 1 : at + 1;
  if (swapWith < 0 || swapWith >= positions.length) return set;

  const from = positions[at]!;
  const to = positions[swapWith]!;
  const fields = [...set.fields];
  fields[from] = set.fields[to];
  fields[to] = set.fields[from];
  return { fields, initializers: set.initializers };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Initializer values by target key, last one winning — which is the engine's
 * reading, because it assigns in document order.
 */
function initializersByKey(set: ProcessVariableSet): Map<string, unknown> {
  const byKey = new Map<string, unknown>();
  for (const entry of set.initializers) {
    const record = asRecord(entry);
    const key = asString(record.targetKey);
    if (key) byKey.set(key, record.value);
  }
  return byKey;
}

/** The updated record, or null when the value it already holds is the one asked for. */
function assignValueType(
  record: Record<string, unknown>,
  value: string,
): Record<string, unknown> | null {
  const next = asValueType(value);
  return record.valueType === next ? null : { ...record, valueType: next };
}

/** The updated record, or null when nothing would change. See the caller's note. */
function assignLocalized(
  record: Record<string, unknown>,
  property: "label" | "description",
  value: string,
  locale: string,
): Record<string, unknown> | null {
  const stored = isRecord(record[property])
    ? (record[property] as Record<string, unknown>)
    : null;
  const text = value.trim();

  if (text.length === 0) {
    if (stored === null || stored[locale] === undefined) return null;
    const { [locale]: _removed, ...rest } = stored;
    return Object.keys(rest).length === 0
      ? omit(record, property)
      : { ...record, [property]: rest };
  }

  if (stored?.[locale] === text) return null;
  return { ...record, [property]: { ...(stored ?? {}), [locale]: text } };
}

function omit(
  record: Record<string, unknown>,
  property: string,
): Record<string, unknown> {
  const { [property]: _removed, ...rest } = record;
  return rest;
}

/** A stored `valueType` when the contract names it, and `string` otherwise. */
function asValueType(value: unknown): ProcessVariableValueType {
  return (PROCESS_VARIABLE_VALUE_TYPES as readonly string[]).includes(value as string)
    ? (value as ProcessVariableValueType)
    : "string";
}

/**
 * A locale map's text for a locale, then English, then any of them. The same
 * chain `presentation.ts` uses on a catalog label, and for the same reason:
 * choosing a locale belongs to whatever renders the text.
 */
function localized(value: unknown, locale: string): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!isRecord(value)) return null;
  const map = value as Record<string, unknown>;
  const exact = asString(map[locale]);
  if (exact) return exact;
  const english = asString(map.en);
  if (english) return english;
  for (const entry of Object.values(map)) {
    const text = asString(entry);
    if (text) return text;
  }
  return null;
}

function isRecord(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? (value as Record<string, unknown>) : {};
}

/** Identical to the `asString` every other reader of a stored graph uses. */
function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
