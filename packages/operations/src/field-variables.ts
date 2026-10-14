// SPDX-License-Identifier: BUSL-1.1
/**
 * The one typed-variable contract.
 *
 * An authored field already says what its value is: the type axis (`osfType`
 * and the `baseType` behind it), the cardinality, the closed domain of its
 * options, the entity a reference names, and the bounds its validation
 * declares. `variables` says whether that field also accepts a *variable* in
 * place of a literal, and in which of the two shapes:
 *
 * - `whole`: the field's entire value is bound to one variable. The variable's
 *   own declared type must satisfy the destination contract exactly, and the
 *   resolved value is then validated by the field's own canonical validator.
 * - `template`: the field's text contains `{{…}}` tokens that are replaced by
 *   the formatted text of each variable. Only a text destination can hold a
 *   template, and only a formattable scalar can be spliced into one.
 *
 * `both` permits either and `none` permits neither — a `{{…}}` sequence in a
 * `none` field is literal text, never a binding discovered by duck typing.
 *
 * Two namespaces exist, and they are always written out: `chips.<key>` is a
 * tenant-scoped reusable global and `local.<key>` is a value the current
 * record, document or invocation supplies. A key in one namespace never
 * shadows the same key in the other, because the namespace is part of the
 * reference rather than a search order.
 *
 * What this module does NOT do: resolve values (the owner of the namespace
 * does, under its own authorization), and re-validate a resolved value
 * against the destination field (the field's own canonical validator —
 * `fieldSchema` through Ajv on a transport, the content engine's shape checks
 * in a template — remains the one value contract). It decides compatibility
 * from authoritative metadata, parses references, checks that a source kept
 * its own declared contract, and formats a scalar as text. A caller that
 * cannot resolve a variable gets a refusal, never a fallback value.
 *
 * Refusal messages name types, keys and namespaces. They never carry a
 * resolved value, so a refusal cannot print the secret it refused.
 */

import { isBaseType } from "./field-resolution.js";
import { decimalText } from "./scalar-projection.js";
import type {
  OperationFieldBaseType,
  OperationFieldValidation,
  ResolvedOperationField,
} from "./field-schema-types.js";

export type FieldVariableMode = "none" | "whole" | "template" | "both";

/**
 * Every mode a field may author. Exported so a surface that reads a mode out
 * of compiled metadata can refuse an unrecognised one instead of discarding
 * it — dropping a mode would silently turn a field that accepts variables
 * into one that holds the token as text.
 */
export const FIELD_VARIABLE_MODES = Object.freeze(
  ["none", "whole", "template", "both"] as const satisfies readonly FieldVariableMode[],
);

export function isFieldVariableMode(value: unknown): value is FieldVariableMode {
  return typeof value === "string" && (FIELD_VARIABLE_MODES as readonly string[]).includes(value);
}

/** How a variable fills its destination: as the whole typed value, or as text inside one. */
export type VariableUsage = "whole" | "template";

export type VariableScope = "global" | "local";

/**
 * The authored namespaces and the scope each one is. `chips` is the existing
 * tenant-wide Chip catalogue; a second spelling for the same platform
 * variable is deliberately not introduced.
 */
export const VARIABLE_NAMESPACE_SCOPES = Object.freeze({
  chips: "global",
  local: "local",
} as const satisfies Record<string, VariableScope>);

export type VariableNamespace = keyof typeof VARIABLE_NAMESPACE_SCOPES;

export const VARIABLE_NAMESPACES = Object.freeze(
  Object.keys(VARIABLE_NAMESPACE_SCOPES) as readonly VariableNamespace[],
);

export type VariableReference = {
  readonly namespace: VariableNamespace;
  readonly scope: VariableScope;
  readonly key: string;
};

/**
 * What a value is, in the terms the field contract already uses. A slot is the
 * destination's shape, an offer is the source's; compatibility compares the
 * two and nothing else.
 */
export type VariableValueShape = {
  /** The exact type axis: a base type, a osf-type catalog key, or an entity name. */
  readonly osfType: string;
  readonly baseType: OperationFieldBaseType;
  readonly cardinality: "single" | "collection";
  /** Whether the value may be null. A slot that is required is not nullable. */
  readonly nullable?: boolean;
  /** The closed domain, in the value's own type, when the type or field declares one. */
  readonly enum?: readonly (string | number | boolean)[];
  /** The entity a reference names. Present on both sides or on neither. */
  readonly target?: string;
};

export type VariableSlot = VariableValueShape & {
  /** The authored path of the destination field, for refusal messages. */
  readonly path: string;
  readonly mode: FieldVariableMode;
  /**
   * The destination's own bounds. Carried for the caller's canonical
   * validation of the resolved value; compatibility does not read them,
   * because a bound is a fact about a value rather than about a type.
   */
  readonly validation?: OperationFieldValidation;
};

export type VariableOffer = VariableValueShape & {
  readonly source: VariableReference;
};

/**
 * Where the offers of one namespace come from. `map` enumerates them (the
 * typed parameters of a template version, the fields of the record being
 * edited); `uniform` declares the one shape every key in the namespace has,
 * for a catalogue whose members are not enumerated up front and whose value
 * contract is the same for all of them — the Chip catalogue, whose value is
 * plain text by its own authored contract.
 *
 * Either way the shape comes from the owning source. A caller never supplies
 * the type of the variable it is binding.
 */
export type VariableNamespaceSource =
  | { readonly kind: "map"; readonly offers: Readonly<Record<string, VariableValueShape>> }
  | { readonly kind: "uniform"; readonly offer: VariableValueShape }
  /**
   * Every key of this namespace carries its own stored contract, read together
   * with its value under the owning source's authorization — the Chip
   * catalogue, whose value is typed by the FieldDefinition stored beside it.
   * There is nothing to enumerate up front and nothing the caller may declare:
   * the owner resolves the key first and hands the shape it found to
   * `declaredVariableOffer`.
   */
  | { readonly kind: "declared" };

export type VariableCatalogue = Readonly<Partial<Record<VariableNamespace, VariableNamespaceSource>>>;

export type VariableRefusalCode =
  /** The expression is not `<namespace>.<key>`, or its key is not a safe identifier. */
  | "VARIABLE_SYNTAX"
  /** The field does not accept a variable in this shape. */
  | "VARIABLES_NOT_PERMITTED"
  /** No such variable in that namespace, or it is not available to this caller. */
  | "UNKNOWN_VARIABLE"
  | "INCOMPATIBLE_TYPE"
  | "INCOMPATIBLE_CARDINALITY"
  | "INCOMPATIBLE_REFERENCE"
  | "INCOMPATIBLE_DOMAIN"
  /** The value cannot be written as text inside a template. */
  | "UNFORMATTABLE_VALUE"
  /** The source returned no value for a key it declares. */
  | "MISSING_VALUE"
  /** A resolved value does not match the contract its own source declares. */
  | "SOURCE_CONTRACT_VIOLATED";

export class VariableError extends Error {
  constructor(
    readonly code: VariableRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "VariableError";
  }
}

function refuse(code: VariableRefusalCode, message: string): never {
  throw new VariableError(code, message);
}

/** A key segment that would reach the prototype chain is never a variable key. */
const UNSAFE_KEY_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;
/** The Chip key contract (`chip.yaml`) is the longest key any namespace admits. */
const MAX_KEY_LENGTH = 160;

/**
 * One `{{ … }}` token. The inner run is unbounded and brace-free, so an
 * unclosed `{{` fails in linear time instead of backtracking; the surrounding
 * whitespace is trimmed by the parser rather than by the pattern.
 */
export const VARIABLE_TOKEN = /\{\{([^{}]+)\}\}/g;

/** A global match always carries its index; the lib type leaves it optional. */
export function variableTokens(text: string): RegExpExecArray[] {
  return [...text.matchAll(VARIABLE_TOKEN)] as RegExpExecArray[];
}

/**
 * The expression of a string that is exactly one token, i.e. a candidate
 * whole-value binding. `"{{local.amount}}"` is one; `"Due: {{local.amount}}"`
 * is not, and neither is a string with two tokens.
 */
export function wholeVariableExpression(text: string): string | undefined {
  const tokens = variableTokens(text);
  return tokens.length === 1 && tokens[0]![0] === text ? tokens[0]![1]! : undefined;
}

export function parseVariableReference(expression: string): VariableReference {
  const trimmed = expression.trim();
  const separator = trimmed.indexOf(".");
  const namespace = separator > 0 ? trimmed.slice(0, separator) : "";
  const key = separator > 0 ? trimmed.slice(separator + 1) : "";
  if (!Object.hasOwn(VARIABLE_NAMESPACE_SCOPES, namespace)) {
    refuse(
      "VARIABLE_SYNTAX",
      `A variable is written as ${VARIABLE_NAMESPACES.map((name) => `{{${name}.key}}`).join(" or ")}.`,
    );
  }
  if (
    key.length === 0 ||
    key.length > MAX_KEY_LENGTH ||
    !KEY_PATTERN.test(key) ||
    key.split(".").some((segment) => UNSAFE_KEY_SEGMENTS.has(segment))
  ) {
    refuse("VARIABLE_SYNTAX", `${namespace} variable keys are dotted identifiers of at most ${MAX_KEY_LENGTH} characters.`);
  }
  const typed = namespace as VariableNamespace;
  return Object.freeze({ namespace: typed, scope: VARIABLE_NAMESPACE_SCOPES[typed], key });
}

/**
 * The declared shape of one variable, from its own namespace. A namespace the
 * catalogue does not carry is unknown rather than empty: a caller that cannot
 * see a namespace cannot bind into it.
 */
export function variableOffer(catalogue: VariableCatalogue, reference: VariableReference): VariableOffer {
  const source = Object.hasOwn(catalogue, reference.namespace) ? catalogue[reference.namespace] : undefined;
  if (!source) refuse("UNKNOWN_VARIABLE", `No ${reference.namespace} variables are available here.`);
  if (source.kind === "declared") {
    // Not a refusal the caller could fix: whoever asked wired a namespace
    // whose shapes are only known once a key is resolved into the path that
    // compares shapes before resolving one.
    throw new Error(
      `${reference.namespace} variables declare their own type; resolve ${reference.namespace}.${reference.key} and compare through declaredVariableOffer.`,
    );
  }
  const shape = source.kind === "uniform"
    ? source.offer
    : Object.hasOwn(source.offers, reference.key) ? source.offers[reference.key] : undefined;
  if (!shape) refuse("UNKNOWN_VARIABLE", `${reference.namespace}.${reference.key} is not available.`);
  return Object.freeze({ ...shape, source: reference });
}

/** Whether this namespace's shapes come from the source itself, per key. */
export function isDeclaredVariableNamespace(
  catalogue: VariableCatalogue,
  namespace: VariableNamespace,
): boolean {
  return (Object.hasOwn(catalogue, namespace) ? catalogue[namespace] : undefined)?.kind === "declared";
}

/**
 * The offer of one key of a declared namespace, from the contract its own
 * source stores. The shape is the source's, never the caller's: an adapter
 * passes what it read through an authorized canonical read, and the ordinary
 * compatibility comparison runs on it unchanged.
 */
export function declaredVariableOffer(
  reference: VariableReference,
  shape: VariableValueShape,
): VariableOffer {
  return Object.freeze({ ...shape, source: reference });
}

/** Every offer a namespace enumerates; a uniform namespace enumerates none. */
export function variableOffers(catalogue: VariableCatalogue): VariableOffer[] {
  return VARIABLE_NAMESPACES.flatMap((namespace) => {
    const source = Object.hasOwn(catalogue, namespace) ? catalogue[namespace] : undefined;
    if (!source || source.kind !== "map") return [];
    return Object.keys(source.offers)
      .sort()
      .map((key) => variableOffer(catalogue, parseVariableReference(`${namespace}.${key}`)));
  });
}

export function permitsVariableUsage(mode: FieldVariableMode | undefined, usage: VariableUsage): boolean {
  return mode === "both" || mode === usage;
}

/** A base type whose value can be written as text inside a template. */
function formattable(baseType: OperationFieldBaseType): boolean {
  return baseType !== "object";
}

/** The destination declares no semantic refinement of its own base type. */
function unrefined(slot: VariableSlot): boolean {
  return isBaseType(slot.osfType) && slot.enum === undefined && slot.target === undefined;
}

export type VariableCompatibility =
  | { readonly compatible: true }
  | { readonly compatible: false; readonly code: VariableRefusalCode; readonly message: string };

const compatible: VariableCompatibility = Object.freeze({ compatible: true });

function incompatible(code: VariableRefusalCode, message: string): VariableCompatibility {
  return Object.freeze({ compatible: false, code, message });
}

/**
 * Whether one variable may fill one field, from both declared contracts.
 *
 * Whole-value binding keeps the destination's type exactly: the offer declares
 * the same `osfType`, or the destination is a bare base type with no
 * refinement of its own and the offer has that base type. So `multilineText`
 * fills `string`, but an arbitrary `number` never fills `currency`, a `date`
 * never fills `datetime`, a scalar never fills a collection, and a reference
 * only ever fills a reference to the same entity. A narrower domain on the
 * destination needs an offer whose own domain is contained in it.
 *
 * Template interpolation is a text operation: the destination must be text
 * that permits a template, and the offer must be a single formattable scalar
 * that is not an entity reference — an id pasted into prose is neither the
 * record's name nor an authorized read of it.
 */
export function variableCompatibility(
  slot: VariableSlot,
  offer: VariableValueShape,
  usage: VariableUsage,
): VariableCompatibility {
  try {
    assertVariableUsagePermitted(slot, usage);
  } catch (error) {
    if (!(error instanceof VariableError)) throw error;
    return incompatible(error.code, error.message);
  }
  if (usage === "template") {
    if (slot.baseType !== "string" || slot.cardinality !== "single") {
      return incompatible("INCOMPATIBLE_TYPE", `${slot.path} is not a single text value, so it holds no template.`);
    }
    if (offer.cardinality !== "single") {
      return incompatible("INCOMPATIBLE_CARDINALITY", `A collection cannot be written into the text of ${slot.path}.`);
    }
    if (offer.target !== undefined) {
      return incompatible(
        "INCOMPATIBLE_REFERENCE",
        `A ${offer.target} reference cannot be written into the text of ${slot.path}.`,
      );
    }
    if (!formattable(offer.baseType)) {
      return incompatible("UNFORMATTABLE_VALUE", `A ${offer.osfType} value cannot be written as text.`);
    }
    return compatible;
  }
  if (offer.cardinality !== slot.cardinality) {
    return incompatible(
      "INCOMPATIBLE_CARDINALITY",
      `${slot.path} takes a ${slot.cardinality} value, the variable is a ${offer.cardinality} value.`,
    );
  }
  if (offer.target !== slot.target) {
    return incompatible(
      "INCOMPATIBLE_REFERENCE",
      slot.target === undefined
        ? `${slot.path} is not a reference, the variable references ${offer.target}.`
        : `${slot.path} references ${slot.target}, the variable ${offer.target === undefined ? "references nothing" : `references ${offer.target}`}.`,
    );
  }
  if (offer.osfType !== slot.osfType && !(unrefined(slot) && offer.baseType === slot.baseType)) {
    return incompatible(
      "INCOMPATIBLE_TYPE",
      `${slot.path} takes a ${slot.osfType} value, the variable is a ${offer.osfType} value.`,
    );
  }
  if (slot.enum !== undefined) {
    const allowed = new Set<string | number | boolean>(slot.enum);
    if (offer.enum === undefined || !offer.enum.every((value) => allowed.has(value))) {
      return incompatible(
        "INCOMPATIBLE_DOMAIN",
        `${slot.path} admits only its own allowed values, which the variable does not declare.`,
      );
    }
  }
  return compatible;
}

/**
 * The mode half of compatibility, for a caller that must refuse a shape
 * before it knows which variable was named — so that a field which takes no
 * template says so instead of first reporting an unknown key.
 */
export function assertVariableUsagePermitted(slot: VariableSlot, usage: VariableUsage): void {
  if (permitsVariableUsage(slot.mode, usage)) return;
  refuse(
    "VARIABLES_NOT_PERMITTED",
    usage === "whole"
      ? `${slot.path} does not accept a variable as its value.`
      : `${slot.path} does not accept variables in its text.`,
  );
}

export function assertVariableCompatible(
  slot: VariableSlot,
  offer: VariableValueShape,
  usage: VariableUsage,
): void {
  const result = variableCompatibility(slot, offer, usage);
  if (!result.compatible) refuse(result.code, result.message);
}

/**
 * The offers a picker may show for one field. Convenience only: the same
 * comparison runs again where the binding is actually accepted, so a client
 * that offers something else gains nothing.
 */
export function compatibleVariableOffers<T extends VariableValueShape>(
  slot: VariableSlot,
  offers: readonly T[],
  usage: VariableUsage,
): T[] {
  return offers.filter((offer) => variableCompatibility(slot, offer, usage).compatible);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** A calendar date that exists, written exactly as `YYYY-MM-DD`. */
function isDateText(value: unknown): boolean {
  return typeof value === "string" &&
    DATE.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
}

/**
 * Whether one value has a base type, in the one reading every surface shares.
 * An integer is a safe integer, a number is finite, a date and a datetime are
 * their exact ISO spellings, an object is a plain object. Collections are the
 * caller's: this is the type of one value.
 */
export function matchesBaseType(baseType: OperationFieldBaseType, value: unknown): boolean {
  switch (baseType) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "date":
      return isDateText(value);
    case "datetime":
      return typeof value === "string" && DATETIME.test(value) && isDateText(value.slice(0, 10)) &&
        Number.isFinite(Date.parse(value));
    case "boolean":
      return typeof value === "boolean";
    default:
      return typeof value === "string";
  }
}

/**
 * Refuse a resolved value that does not match the contract its own source
 * declared: a plain-text catalogue that returns an object, a single-valued
 * parameter that returns an array, a non-nullable source that returns null.
 * `false`, `0`, `""` and `[]` are values and pass; only `undefined` is absent.
 *
 * This is the source's own integrity, not the destination's contract — the
 * destination field is validated by its own canonical validator afterwards.
 */
export function assertVariableSourceValue(offer: VariableOffer, value: unknown): void {
  const name = `${offer.source.namespace}.${offer.source.key}`;
  if (value === undefined) refuse("MISSING_VALUE", `${name} has no value.`);
  if (value === null) {
    if (offer.nullable) return;
    refuse("SOURCE_CONTRACT_VIOLATED", `${name} is not nullable but resolved to null.`);
  }
  if (offer.cardinality === "collection") {
    if (!Array.isArray(value)) {
      refuse("SOURCE_CONTRACT_VIOLATED", `${name} is a collection but did not resolve to one.`);
    }
    for (const item of value) {
      if (!matchesBaseType(offer.baseType, item)) {
        refuse("SOURCE_CONTRACT_VIOLATED", `${name} resolved to an item that is not a ${offer.baseType} value.`);
      }
    }
    return;
  }
  if (Array.isArray(value) || !matchesBaseType(offer.baseType, value)) {
    refuse("SOURCE_CONTRACT_VIOLATED", `${name} did not resolve to a ${offer.baseType} value.`);
  }
}

/**
 * A scalar as the text a template splices in. A number prints every digit of
 * its exact decimal value without exponent notation, through the same
 * conversion the transports use for decimals, so a bound amount reads the way
 * it is stored. A boolean is `true` or `false`; a date and a datetime keep
 * their ISO spelling. Nothing else is text: an object, a collection, a null
 * and an absent value are refused rather than printed as `[object Object]`,
 * `null` or an empty string.
 *
 * Locale-aware presentation (thousand separators, a currency symbol, a
 * display scale) belongs to the renderer that shows the value, not to the
 * text written into stored content.
 */
export function variableText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(decimalText(value));
  if (typeof value === "bigint") return value.toString();
  refuse("UNFORMATTABLE_VALUE", "Only a text, numeric or boolean variable can be written into text.");
}

/**
 * Every ASCII punctuation character, the exact set CommonMark says may be
 * backslash-escaped. One class, so nothing is covered by accident and nothing
 * is left out: the emphasis and strong delimiters, the link and image
 * brackets and parentheses, the code-span backtick, the raw-HTML `<` and the
 * entity `&`, the heading `#`, the list and rule markers, the table pipe, the
 * blockquote `>` and the escape character itself.
 */
const MARKDOWN_PUNCTUATION = /[!-/:-@[-`{-~]/g;

/**
 * One variable's text as DATA inside Markdown.
 *
 * A filled value is never syntax: a client named `Bouw*Groep* BV` must not
 * turn into emphasis where the template writes `**Klant:** {{local.client}}`,
 * and a value of `[x](javascript:…)`, `<img onerror=…>`, `&lt;`, `` `code` ``
 * or `|` must not become a link, raw HTML, an entity, a code span or a table
 * cell. Escaping only the emphasis characters left every one of those open,
 * so the whole punctuation class is escaped instead — a backslash before an
 * ASCII punctuation character renders as that character and nothing else.
 *
 * Two deliberate limits, both of them properties of Markdown rather than of
 * this function: a backslash escape is literal text inside a code span, so a
 * value spliced into one the author opened is not protected by it (the
 * content engine escapes the value, it does not rewrite the author's
 * formatting); and a line break inside a multi-line value stays a line break,
 * because a multi-line global is legitimately multi-line.
 */
export function escapeMarkdownVariableText(text: string): string {
  return text.replace(MARKDOWN_PUNCTUATION, (character) => `\\${character}`);
}

/**
 * The variable contract of one resolved field: its own type axis, cardinality,
 * domain and bounds, plus the mode it authored. `required` is the one reading
 * of nullability — a required field takes no null.
 */
export function fieldVariableSlot(
  field: Pick<
    ResolvedOperationField,
    "key" | "osfType" | "baseType" | "cardinality" | "required" | "validation" | "relationship" | "variables"
  >,
  options: { readonly path?: string; readonly enum?: readonly (string | number | boolean)[] } = {},
): VariableSlot {
  return Object.freeze({
    path: options.path ?? field.key,
    mode: field.variables ?? "none",
    osfType: field.osfType,
    baseType: field.baseType,
    cardinality: field.cardinality,
    nullable: !field.required,
    ...(options.enum ? { enum: options.enum } : {}),
    ...(field.relationship?.target ? { target: field.relationship.target } : {}),
    ...(field.validation ? { validation: field.validation } : {}),
  });
}
