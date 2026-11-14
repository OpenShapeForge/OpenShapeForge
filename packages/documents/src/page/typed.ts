// SPDX-License-Identifier: BUSL-1.1
/**
 * A block whose content is a materialized value (QuotePricing, QuoteScope, …)
 * drawn on a page. Only the block's frozen public output schema is read: an
 * object becomes label/value rows, a list of objects a table with the
 * authored column labels, a list of scalars a list. Every text is escaped.
 * Business validation is the materializer's; this checks shape only.
 */
type Schema = Readonly<Record<string, unknown>>;
const isObject = (value: unknown): value is Schema => !!value && typeof value === "object" && !Array.isArray(value);

export class TypedPageBlockError extends Error {}
const fail = (message: string): never => { throw new TypedPageBlockError(message); };
const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function typeOf(schema: Schema): unknown {
  return Array.isArray(schema.type) ? schema.type.find((type) => type !== "null") : schema.type;
}

export function schemaLabel(schema: Schema, key: string, locale: string): string {
  const i18n = isObject(schema["x-osf-i18n"]) ? schema["x-osf-i18n"] : undefined;
  const labels = i18n && isObject(i18n.title) ? i18n.title : undefined;
  const label = labels?.[locale] ?? labels?.[locale.split("-")[0]!] ?? schema.title ?? key;
  return typeof label === "string" ? label : key;
}

function scalar(value: unknown, schema: Schema): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const type = typeOf(schema);
  if (type === "string" && typeof value === "string") return escape(value);
  if ((type === "number" || type === "integer") && typeof value === "number" && Number.isFinite(value)) return escape(String(value));
  if (type === "boolean" && typeof value === "boolean") return value ? "✓" : "–";
  return fail("A value does not match its output schema.");
}

function table(rows: readonly unknown[], item: Schema, locale: string): string {
  const properties = isObject(item.properties) ? Object.entries(item.properties).filter((entry): entry is [string, Schema] => isObject(entry[1]) && typeOf(entry[1]) !== "object" && typeOf(entry[1]) !== "array") : [];
  if (!properties.length) return "";
  const head = properties.map(([key, schema], index) => `<div role="columnheader" class="c${index ? " n" : ""}">${escape(schemaLabel(schema, key, locale))}</div>`).join("");
  const body = rows.map((row) => {
    if (!isObject(row)) return fail("A table row is not an object.");
    return `<div role="row" class="r">${properties.map(([key, schema], index) => `<div role="cell" class="c${index ? " n" : ""}">${scalar(row[key], schema) ?? ""}</div>`).join("")}</div>`;
  }).join("");
  return `<div role="table" class="t"><div role="row" class="r h">${head}</div>${body}</div>`;
}

function part(value: unknown, schema: Schema, key: string, locale: string, depth: number): { rows: string[]; parts: string[] } {
  if (depth > 8) fail("The output schema nests too deeply.");
  const type = typeOf(schema);
  const label = escape(schemaLabel(schema, key, locale));
  if (value === null || value === undefined) return { rows: [], parts: [] };
  if (type === "object") {
    if (!isObject(value) || !isObject(schema.properties)) return fail("A value does not match its output schema.");
    const rows: string[] = [], parts: string[] = [];
    for (const [name, child] of Object.entries(schema.properties)) {
      if (!isObject(child) || !Object.hasOwn(value, name)) continue;
      const inner = part(value[name], child, name, locale, depth + 1);
      rows.push(...inner.rows); parts.push(...inner.parts);
    }
    const kv = rows.length ? `<div role="table" class="t kv">${rows.join("")}</div>` : "";
    return depth === 0 ? { rows: [], parts: [kv, ...parts].filter(Boolean) } : { rows: [], parts: rows.length || parts.length ? [`<div class="th">${label}</div>${kv}${parts.join("")}`] : [] };
  }
  if (type === "array") {
    if (!Array.isArray(value)) return fail("A value does not match its output schema.");
    if (!value.length) return { rows: [], parts: [] };
    const item = isObject(schema.items) ? schema.items : fail("A list has no item schema.");
    const inner = typeOf(item) === "object" ? table(value, item, locale) : `<ul>${value.map((entry) => `<li>${scalar(entry, item) ?? ""}</li>`).join("")}</ul>`;
    return { rows: [], parts: inner ? [`<div class="th">${label}</div>${inner}`] : [] };
  }
  const text = scalar(value, schema);
  return { rows: text === undefined ? [] : [`<div role="row" class="r"><div role="rowheader" class="c">${label}</div><div role="cell" class="c n">${text}</div></div>`], parts: [] };
}

/** The block's HTML: `schema` is the materialization's value schema, `value` the materialized value. */
export function typedPageBlock(value: unknown, schema: unknown, locale: string, styleClass: string): string {
  if (!isObject(schema)) fail("The block has no output schema.");
  return `<div class="b typed ${styleClass}">${part(value, schema as Schema, "", locale, 0).parts.join("")}</div>`;
}

/**
 * Tables are rows of blocks, not `<table>`: a print engine breaks a nested
 * table across pages without the room the page keeps for its footer, and it
 * keeps that room between ordinary blocks. A row never breaks.
 */
export const TYPED_BLOCK_RULES = [
  ".typed>*+*{margin-top:12px}", ".typed .r{display:flex;break-inside:avoid;border-bottom:1px solid rgba(0,0,0,.12)}",
  ".typed .c{flex:1 1 0;min-width:0;padding:6px 0;text-align:left;overflow-wrap:anywhere}", ".typed .c:first-child{flex-grow:2}", ".typed .n{text-align:right;padding-left:16px}",
  ".typed .r.h{font-weight:600;border-bottom-color:currentColor}", ".typed .th{font-weight:600;margin-bottom:4px}", ".typed ul{margin:0;padding-left:1.2em}",
];
