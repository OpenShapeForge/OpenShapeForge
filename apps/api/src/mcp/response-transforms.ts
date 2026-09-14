// SPDX-License-Identifier: BUSL-1.1
/**
 * Declarative response transforms — `responseMapping.transforms: Step[]`.
 *
 * Path extraction (`rootPath`, `fieldPaths`) covers responses whose shape is
 * already the shape the Capability wants. Some providers answer with data
 * that no path can reach: a header list of `{name, value}` pairs, a MIME part
 * tree with base64url bodies, HTML where the tool wants text. Rather than a
 * provider-specific decoder in core (which would have to be rewritten for the
 * next provider with a similar quirk), the operation row composes a handful
 * of GENERIC primitives — flatten a tree, index a list by name, decode,
 * filter, map, shape — into a pipeline that runs after the field paths and
 * before the binding's output mapping. Rows stay data; this module stays the
 * only interpreter.
 *
 * Semantics: steps run in order against a SCOPE (the outputs record at the
 * root; a copy of the current item inside `map`). Paths are dot-separated
 * plain keys; `$parent.` (repeatable) reads from the enclosing `map` scope.
 * A step's `to` is where the result lands; when omitted the result replaces
 * the value at `from`. A malformed step fails the call as
 * SERVICE_MISCONFIGURED — a definition mistake, never a provider outcome.
 */
import { HttpError } from "../rest/http-error.js";

type Rec = Record<string, unknown>;

/** A pipeline scope: the record steps read from and write to, plus parents. */
type Scope = { value: Rec; parent?: Scope | undefined };

type Condition = { path: string; equals?: unknown; exists?: true };

type Step = Rec & { op: string };

const MAX_MIME_DEPTH = 32;
const PARENT_PREFIX = "$parent.";

function isRecord(value: unknown): value is Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function misconfigured(index: number, op: unknown, message: string): HttpError {
  return new HttpError(
    502,
    "SERVICE_MISCONFIGURED",
    `Response transform step ${index} (op ${JSON.stringify(op ?? null)}): ${message}`,
  );
}

/** Walk `$parent.` prefixes, then a dot path, in the given scope. */
function readPath(scope: Scope | undefined, path: string): unknown {
  let current: Scope | undefined = scope;
  let rest = path;
  while (rest.startsWith(PARENT_PREFIX)) {
    current = current?.parent;
    rest = rest.slice(PARENT_PREFIX.length);
  }
  if (!current) return undefined;
  let value: unknown = current.value;
  for (const segment of rest.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Rec)[segment];
  }
  return value;
}

/** Write at a dot path in the scope's record, creating intermediate objects. */
function writePath(scope: Scope, path: string, value: unknown): void {
  const segments = path.split(".");
  let current = scope.value;
  for (const segment of segments.slice(0, -1)) {
    // Copy-on-write: intermediate objects may be shared with the input.
    const next = current[segment];
    current[segment] = isRecord(next) ? { ...next } : {};
    current = current[segment] as Rec;
  }
  current[segments[segments.length - 1]!] = value;
}

/* ------------------------------------------------------------------------ */
/* Individual primitives — pure, exported for unit tests.                    */
/* ------------------------------------------------------------------------ */

/** `[{name, value}]` → object keyed by lowercased name; repeats joined. */
export function headersByName(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(value)) return out;
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.name !== "string") continue;
    const key = entry.name.trim().toLowerCase();
    const text =
      entry.value === undefined || entry.value === null
        ? ""
        : String(entry.value);
    out[key] = key in out ? `${out[key]}, ${text}` : text;
  }
  return out;
}

/**
 * Flatten a MIME part tree depth-first in document order. Leaves (no
 * `parts`) and any node carrying `body.attachmentId` are emitted as copies
 * without `parts`, with `headers` indexed by name.
 */
export function flattenMimeParts(root: unknown): Rec[] {
  const out: Rec[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (!isRecord(node) || depth > MAX_MIME_DEPTH) return;
    const { parts, ...rest } = node;
    const body = isRecord(node.body) ? node.body : undefined;
    const hasChildren = Array.isArray(parts);
    if (!hasChildren || body?.attachmentId !== undefined) {
      out.push({ ...rest, headers: headersByName(node.headers) });
    }
    if (hasChildren) for (const child of parts) visit(child, depth + 1);
  };
  visit(root, 0);
  return out;
}

/** base64 / base64url (either alphabet, any padding) → UTF-8 text. */
export function decodeBase64Url(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalised = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalised, "base64").toString("utf8");
}

const BLOCK_TAGS =
  "p|div|tr|h[1-6]|blockquote|pre|table|ul|ol|section|article|header|footer|hr";
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#[0-9]+|[a-z]+[0-9]*);/gi,
    (match, body: string) => {
      const lower = body.toLowerCase();
      if (lower.startsWith("#x")) {
        const code = Number.parseInt(lower.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      if (lower.startsWith("#")) {
        const code = Number.parseInt(lower.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return NAMED_ENTITIES[lower] ?? match;
    },
  );
}

/** HTML → readable plain text (blocks become lines, lists get `- `). */
export function htmlToText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let text = value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/\r\n?|\n/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li\s*>/gi, "")
    .replace(/<\/?(td|th)\b[^>]*>/gi, "\t")
    .replace(new RegExp(`</?(${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n")
    .replace(/<[^>]+>/g, "");
  text = decodeEntities(text);
  return text
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** RFC 5322 address-list → entries; commas in quotes or `<…>` do not split. */
export function splitAddressList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let angle = false;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === "<") angle = true;
    else if (!quoted && char === ">") angle = false;
    if (char === "," && !quoted && !angle) {
      out.push(current);
      current = "";
    } else current += char;
  }
  out.push(current);
  return out.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/* ------------------------------------------------------------------------ */
/* Conditions and the pipeline interpreter.                                  */
/* ------------------------------------------------------------------------ */

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function parseWhere(step: Step, index: number): Condition[] {
  const raw = Array.isArray(step.where) ? step.where : [step.where];
  return raw.map((entry) => {
    if (!isRecord(entry) || typeof entry.path !== "string")
      throw misconfigured(
        index,
        step.op,
        "`where` needs {path, equals?|exists?}",
      );
    return entry as Condition;
  });
}

function matches(item: unknown, conditions: Condition[]): boolean {
  const scope: Scope | undefined = isRecord(item) ? { value: item } : undefined;
  return conditions.every((condition) => {
    const actual = scope ? readPath(scope, condition.path) : undefined;
    if (condition.exists === true && !present(actual)) return false;
    if ("equals" in condition) {
      const expected = condition.equals;
      if (typeof actual === "string" && typeof expected === "string")
        return actual.toLowerCase() === expected.toLowerCase();
      return actual === expected;
    }
    return true;
  });
}

function requireString(step: Step, index: number, key: string): string {
  const value = step[key];
  if (typeof value !== "string" || value.length === 0)
    throw misconfigured(index, step.op, `\`${key}\` must be a non-empty path`);
  return value;
}

function shapeOne(scope: Scope, fields: Rec, step: Step, index: number): Rec {
  const out: Rec = {};
  for (const [key, spec] of Object.entries(fields)) {
    if (typeof spec === "string") out[key] = readPath(scope, spec);
    else if (isRecord(spec) && typeof spec.exists === "string")
      out[key] = present(readPath(scope, spec.exists));
    else if (isRecord(spec) && "literal" in spec) out[key] = spec.literal;
    else
      throw misconfigured(
        index,
        step.op,
        `field "${key}" must be a path, {exists: path} or {literal: value}`,
      );
  }
  return out;
}

/** Run one step list against a scope; returns the (possibly replaced) record. */
function runSteps(scope: Scope, steps: unknown, index: number): Rec {
  if (!Array.isArray(steps))
    throw misconfigured(
      index,
      undefined,
      "`transforms`/`steps` must be an array",
    );
  let current = scope;
  steps.forEach((raw, i) => {
    if (!isRecord(raw) || typeof raw.op !== "string")
      throw misconfigured(
        i,
        (raw as Rec | null)?.op,
        "a step needs a string `op`",
      );
    const step = raw as Step;
    const to = typeof step.to === "string" ? step.to : undefined;
    const unary = (fn: (value: unknown) => unknown): void => {
      const from = requireString(step, i, "from");
      writePath(current, to ?? from, fn(readPath(current, from)));
    };
    switch (step.op) {
      case "headers-by-name":
        unary(headersByName);
        break;
      case "mime-parts":
        unary(flattenMimeParts);
        break;
      case "base64url":
        unary(decodeBase64Url);
        break;
      case "html-to-text":
        unary(htmlToText);
        break;
      case "address-list":
        unary(splitAddressList);
        break;
      case "first": {
        const where = parseWhere(step, i);
        requireString(step, i, "to");
        unary((list) =>
          Array.isArray(list)
            ? (list.find((item) => matches(item, where)) ?? null)
            : null,
        );
        break;
      }
      case "filter": {
        const where = parseWhere(step, i);
        unary((list) =>
          Array.isArray(list)
            ? list.filter((item) => matches(item, where))
            : [],
        );
        break;
      }
      case "map": {
        if (!Array.isArray(step.steps))
          throw misconfigured(i, step.op, "`steps` must be an array");
        const parent = current;
        unary((list) =>
          Array.isArray(list)
            ? list.map((item) =>
                isRecord(item)
                  ? runSteps({ value: { ...item }, parent }, step.steps, i)
                  : item,
              )
            : [],
        );
        break;
      }
      case "shape": {
        if (!isRecord(step.fields))
          throw misconfigured(i, step.op, "`fields` must be an object");
        const fields = step.fields;
        if (typeof step.from === "string") {
          const source = readPath(current, step.from);
          const shapeValue = (value: unknown): unknown =>
            isRecord(value)
              ? shapeOne({ value, parent: current }, fields, step, i)
              : undefined;
          const result = Array.isArray(source)
            ? source.map(shapeValue)
            : shapeValue(source);
          writePath(current, to ?? step.from, result);
        } else if (to !== undefined) {
          writePath(current, to, shapeOne(current, fields, step, i));
        } else {
          current = {
            value: shapeOne(current, fields, step, i),
            parent: current.parent,
          };
        }
        break;
      }
      case "coalesce": {
        if (
          !Array.isArray(step.from) ||
          step.from.some((path) => typeof path !== "string")
        )
          throw misconfigured(i, step.op, "`from` must be an array of paths");
        const target = requireString(step, i, "to");
        const found = (step.from as string[])
          .map((path) => readPath(current, path))
          .find(present);
        writePath(current, target, found ?? null);
        break;
      }
      default:
        throw misconfigured(i, step.op, "unknown op");
    }
  });
  return current.value;
}

/**
 * Apply `responseMapping.transforms` to the operation outputs. Pure: the
 * input record is never mutated (steps write into a shallow copy; `map`
 * copies each item before its steps run).
 */
export function applyResponseTransforms(
  outputs: Record<string, unknown>,
  transforms: unknown,
): Record<string, unknown> {
  return runSteps({ value: { ...outputs } }, transforms, -1);
}
