// SPDX-License-Identifier: BUSL-1.1
/**
 * A block whose content is a materialized value (QuotePricing, QuoteScope, …)
 * drawn on a page. Only the block's frozen public output schema is read: an
 * object becomes label/value rows, a list of objects a table with the
 * authored column labels (the columns the list names, else all of them), a
 * list of scalars a list. A `money` value is written by the platform's money
 * formatter. Every text is escaped.
 * Business validation is the materializer's; this checks shape only.
 */
import { isMoneySchema, moneyScope, moneyText, within, type MoneyScope } from "../content/typed-money.js";

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

function scalar(value: unknown, schema: Schema, scope: MoneyScope): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (isMoneySchema(schema)) return escape(moneyText(value, schema, scope) ?? fail("An amount has no currency or is not a number."));
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

type Rows = { open: string; close: string; header?: string; rows: string[] };
type Part = string | Rows;

function table(rows: readonly unknown[], list: Schema, item: Schema, locale: string, scope: MoneyScope): Rows | undefined {
  const columns = tableColumns(list, item);
  if (!columns.length) return undefined;
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
    return `<div role="row" class="r">${columns.map((column, index) => `${open("cell", column, index, false)}${scalar(row[column.key], column.schema, within(scope, row)) ?? ""}</div>`).join("")}</div>`;
  });
  return { open: '<div role="table" class="t">', close: "</div>", header: `<div role="row" class="r h">${head}</div>`, rows: body };
}

function part(value: unknown, schema: Schema, key: string, locale: string, depth: number, scope: MoneyScope): { rows: string[]; parts: Part[] } {
  if (depth > 8) fail("The output schema nests too deeply.");
  const type = typeOf(schema);
  const label = escape(schemaLabel(schema, key, locale));
  if (value === null || value === undefined) return { rows: [], parts: [] };
  if (type === "object") {
    if (!isObject(value) || !isObject(schema.properties)) return fail("A value does not match its output schema.");
    const rows: string[] = [], parts: Part[] = [];
    for (const [name, child] of Object.entries(schema.properties)) {
      if (!isObject(child) || !Object.hasOwn(value, name)) continue;
      const inner = part(value[name], child, name, locale, depth + 1, within(scope, value));
      rows.push(...inner.rows); parts.push(...inner.parts);
    }
    const tables: Part[] = rows.length ? [{ open: '<div role="table" class="t kv">', close: "</div>", rows }, ...parts] : parts;
    return { rows: [], parts: depth > 0 && tables.length ? [`<div class="th">${label}</div>`, ...tables] : tables };
  }
  if (type === "array") {
    if (!Array.isArray(value)) return fail("A value does not match its output schema.");
    if (!value.length) return { rows: [], parts: [] };
    const item = isObject(schema.items) ? schema.items : fail("A list has no item schema.");
    const inner = typeOf(item) === "object" ? table(value, schema, item, locale, scope) : {
      open: "<ul>", close: "</ul>", rows: value.map((entry) => `<li>${scalar(entry, item, scope) ?? ""}</li>`),
    };
    return { rows: [], parts: inner ? [`<div class="th">${label}</div>`, inner] : [] };
  }
  const text = scalar(value, schema, scope);
  return { rows: text === undefined ? [] : [`<div role="row" class="r"><div role="rowheader" class="c">${label}</div><div role="cell" class="c n">${text}</div></div>`], parts: [] };
}

function typedParts(value: unknown, schema: unknown, locale: string): Part[] {
  if (!isObject(schema)) return fail("The block has no output schema.");
  return part(value, schema, "", locale, 0, moneyScope(schema, locale)).parts;
}

function typedHtml(styleClass: string, content: string, continued = false): string {
  return `<div class="b typed ${styleClass}${continued ? " typed-continued" : ""}">${content}</div>`;
}

/** The block's HTML for a renderer that handles page breaks itself. */
export function typedPageBlock(value: unknown, schema: unknown, locale: string, styleClass: string): string {
  const html = typedParts(value, schema, locale).map((item) =>
    typeof item === "string" ? item : item.open + (item.header ?? "") + item.rows.join("") + item.close,
  ).join("");
  return typedHtml(styleClass, html);
}

/** Measurable pieces for an explicitly positioned page. Keep headings with the first row. */
export function typedPageFragments(value: unknown, schema: unknown, locale: string, styleClass: string) {
  const fragments: { html: string; gap: number }[] = [];
  let headings = "";
  for (const item of typedParts(value, schema, locale)) {
    if (typeof item === "string") {
      headings += item;
      continue;
    }
    item.rows.forEach((row, index) => {
      const content = index === 0 ? headings + item.open + (item.header ?? "") : item.open;
      fragments.push({
        html: typedHtml(styleClass, content + row + item.close, index < item.rows.length - 1),
        gap: index === 0 ? 12 : 0,
      });
    });
    headings = "";
  }
  return fragments;
}

/**
 * Tables are rows of blocks, not `<table>`: a print engine breaks a nested
 * table across pages without the room the page keeps for its footer, and it
 * keeps that room between ordinary blocks. A row never breaks.
 */
export const TYPED_BLOCK_RULES = [
  ".typed>*+*{margin-top:12px}", ".typed .r{display:flex;break-inside:avoid}", ".typed .t .r.h,.typed:not(.typed-continued) .t .r:last-child{border-bottom:1px solid #dee3ea}",
  ".typed .c{flex:1 1 0;min-width:0;box-sizing:border-box;padding:8px 8px 12px 0;text-align:left;overflow-wrap:break-word}",
  ".typed .p,.typed .m,.typed .n{padding-left:12px}", ".typed .m{text-align:center}", ".typed .n{text-align:right}", ".typed .c:last-child{padding-right:0}",
  ".typed .c:first-child{flex-grow:2}", ".typed .r.h{font-weight:600}", ".typed .th{font-weight:600;margin-bottom:4px}", ".typed ul{margin:0;padding-left:1.2em}",
];
