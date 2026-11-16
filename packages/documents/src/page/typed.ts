// SPDX-License-Identifier: BUSL-1.1
/**
 * A block whose content is a materialized value (QuotePricing, QuoteScope, …)
 * drawn on a page. Only the block's frozen public output schema is read: an
 * object becomes label/value rows, a list of objects a table with the
 * authored column labels (the columns the list names, else all of them), a
 * list of scalars a list. Every text is escaped.
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

type Column = { readonly key: string; readonly schema: Schema; readonly width?: number; readonly align?: "start" | "center" | "end" };

/**
 * The columns a list of objects is drawn with. A list names them in
 * `x-osf-presentation.columns` (`field`, and optionally a fixed `width` in
 * px and an `align`), in the order they read; a list that names none shows
 * every scalar property. A named field the item schema lacks is skipped.
 */
function tableColumns(list: Schema, item: Schema): Column[] {
  const scalars = isObject(item.properties) ? Object.entries(item.properties).filter((entry): entry is [string, Schema] => isObject(entry[1]) && typeOf(entry[1]) !== "object" && typeOf(entry[1]) !== "array") : [];
  const presentation = isObject(list["x-osf-presentation"]) ? list["x-osf-presentation"].columns : undefined;
  if (!Array.isArray(presentation)) return scalars.map(([key, schema]) => ({ key, schema }));
  return presentation.flatMap((column): Column[] => {
    const found = isObject(column) ? scalars.find(([key]) => key === column.field) : undefined;
    if (!found || !isObject(column)) return [];
    const width = typeof column.width === "number" && Number.isFinite(column.width) && column.width >= 24 && column.width <= 600 ? Math.round(column.width) : undefined;
    const align = column.align === "start" || column.align === "center" || column.align === "end" ? column.align : undefined;
    return [{ key: found[0], schema: found[1], ...(width === undefined ? {} : { width }), ...(align === undefined ? {} : { align }) }];
  });
}

function table(rows: readonly unknown[], list: Schema, item: Schema, locale: string): string {
  const columns = tableColumns(list, item);
  if (!columns.length) return "";
  // A column is a label column first and an amount column after it, unless the list says how it aligns.
  const open = (role: string, column: Column, index: number, head: boolean) => {
    const align = column.align ?? (index ? "end" : "start");
    // A heading reads from the start of a centred column, as the design's table does.
    const side = align === "end" ? " n" : align === "center" && !head ? " m" : index ? " p" : "";
    return `<div role="${role}" class="c${side}"${column.width === undefined ? "" : ` style="flex:0 0 ${column.width}px"`}>`;
  };
  const head = columns.map((column, index) => `${open("columnheader", column, index, true)}${escape(schemaLabel(column.schema, column.key, locale))}</div>`).join("");
  const body = rows.map((row) => {
    if (!isObject(row)) return fail("A table row is not an object.");
    return `<div role="row" class="r">${columns.map((column, index) => `${open("cell", column, index, false)}${scalar(row[column.key], column.schema) ?? ""}</div>`).join("")}</div>`;
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
    const inner = typeOf(item) === "object" ? table(value, schema, item, locale) : `<ul>${value.map((entry) => `<li>${scalar(entry, item) ?? ""}</li>`).join("")}</ul>`;
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
  ".typed>*+*{margin-top:12px}", ".typed .r{display:flex;break-inside:avoid}", ".typed .t .r.h,.typed .t .r:last-child{border-bottom:1px solid #dee3ea}",
  ".typed .c{flex:1 1 0;min-width:0;box-sizing:border-box;padding:8px 8px 12px 0;text-align:left;overflow-wrap:break-word}",
  ".typed .p,.typed .m,.typed .n{padding-left:12px}", ".typed .m{text-align:center}", ".typed .n{text-align:right}", ".typed .c:last-child{padding-right:0}",
  ".typed .c:first-child{flex-grow:2}", ".typed .r.h{font-weight:600}", ".typed .th{font-weight:600;margin-bottom:4px}", ".typed ul{margin:0;padding-left:1.2em}",
];
