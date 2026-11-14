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
  const head = properties.map(([key, schema], index) => `<th${index ? ' class="n"' : ""}>${escape(schemaLabel(schema, key, locale))}</th>`).join("");
  const body = rows.map((row) => {
    if (!isObject(row)) return fail("A table row is not an object.");
    return `<tr>${properties.map(([key, schema], index) => `<td${index ? ' class="n"' : ""}>${scalar(row[key], schema) ?? ""}</td>`).join("")}</tr>`;
  }).join("");
  return `<table class="t"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
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
    const kv = rows.length ? `<table class="kv"><tbody>${rows.join("")}</tbody></table>` : "";
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
  return { rows: text === undefined ? [] : [`<tr><td>${label}</td><td class="n">${text}</td></tr>`], parts: [] };
}

/** The block's HTML: `schema` is the materialization's value schema, `value` the materialized value. */
export function typedPageBlock(value: unknown, schema: unknown, locale: string, styleClass: string): string {
  if (!isObject(schema)) fail("The block has no output schema.");
  return `<div class="b typed ${styleClass}">${part(value, schema as Schema, "", locale, 0).parts.join("")}</div>`;
}

export const TYPED_BLOCK_RULES = [
  ".typed>*+*{margin-top:12px}", ".typed table{width:100%;border-collapse:collapse}", ".typed th,.typed td{text-align:left;padding:6px 0;vertical-align:top}",
  ".typed .n{text-align:right;padding-left:16px}", ".typed thead th{font-weight:600;border-bottom:1px solid currentColor}", ".typed tbody td{border-bottom:1px solid rgba(0,0,0,.12)}",
  ".typed .th{font-weight:600;margin-bottom:4px}", ".typed ul{margin:0;padding-left:1.2em}",
];
