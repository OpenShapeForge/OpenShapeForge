#!/usr/bin/env bun
/**
 * One-off, idempotent rewrite of authoring YAML to the Figma-named component
 * catalog (battery-ds-ai docs/cutover/compiler-catalog-proposal.md, decisions
 * of 2026-11-23):
 *
 * - component names become the design system's Figma names; an old generic
 *   name (Input, Textarea, NumberInput, Switch, ReferenceSelect, ...) becomes
 *   the Figma field the renderer draws for that use today, judged from the
 *   use's own type, cardinality and requiredness;
 * - texts take the design system's slot names (emptyText -> empty, ...);
 * - frontLabelWidth (pixels) becomes labelWidth on Figma's 128/256/384 steps;
 * - props that only styled the old fields are dropped.
 *
 * Edits are made on the source text by node range, so comments, quoting and
 * layout of everything else stay as they are. Running it again changes
 * nothing.
 *
 *   bun packages/compiler/scripts/migrate-figma-catalog.ts [--dry-run] <root>...
 *
 * A root is a directory; every *.yaml / *.yml under it (outside node_modules
 * and generated output) is considered.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";
import { isMap, isPair, isScalar, isSeq, parseAllDocuments, parseDocument, type Node, type Pair, type YAMLMap } from "yaml";

/** The Figma field the old renderer drew for a scalar osfType (its native kind table). */
const NATIVE: Record<string, string> = {
  string: "FieldSingleLine", multilineText: "FieldMultiline", markdown: "FieldMarkdown", email: "FieldEmail", url: "FieldUrl",
  identifier: "FieldIdentifierCode", integer: "FieldIntegerDecimal", number: "FieldIntegerDecimal", percentage: "FieldPercentage",
  measurement: "FieldMeasurement", durationSeconds: "FieldDuration", numericRange: "FieldNumericRange", boolean: "boolean",
  date: "FieldDate", localTime: "FieldTime", datetime: "FieldDateAndTime", dateRange: "FieldDateRange", calendarPeriod: "FieldPeriod", timeZone: "FieldTimezone",
};

/** Battery names that Figma spells differently, and the two file fields Figma has as one. */
const RENAMED: Record<string, string> = {
  FieldRating: "FieldRatingBoundedScale", FieldBankAccount: "FieldBankAccountStructuredId", FieldChildRecords: "FieldChildRecordsLineItems",
  FieldCode: "FieldCodeStructuredJson", FieldLocation: "FieldLocationCoordinates", FieldMultipleFiles: "FieldFileAttachment",
  DateTimePicker: "FieldDateAndTime",
};

/** The scalar widget each old generic name meant, and what that widget draws without a native type. */
const GENERIC: Record<string, string | undefined> = {
  Input: "FieldSingleLine", TextDisplay: "FieldSingleLine", Textarea: "FieldMultiline", MarkdownText: "FieldMarkdown",
  NumberInput: "FieldIntegerDecimal", DatePicker: "FieldDate", Switch: "boolean", JsonFieldEditor: "FieldCodeStructuredJson",
};

/** Text props renamed to the design system's slot names. */
const TEXTS: Record<string, string> = {
  emptyText: "empty", searchPlaceholder: "placeholder", clearLabel: "clear", noResultsText: "noResults", retryLabel: "retry",
  loadingText: "loading", trueLabel: "trueText", falseLabel: "falseText", nullLabel: "nullText", minimumLabel: "minLabel",
  maximumLabel: "maxLabel", maskLabel: "masked", addLabel: "add", removeLabel: "remove", editLabel: "edit",
};
/** Renamed only where the old renderer slotted it: valueLabel is the period's value label, not FieldSystemMetadata's. */
const COMPONENT_TEXTS: Record<string, Record<string, string>> = { FieldPeriod: { valueLabel: "periodLabel" } };

/** Props that only styled the old fields; the design system has no counterpart. */
const DROPPED = new Set(["labelBand", "inputTone", "viewSurface", "spacing", "viewSizing", "labelSpacing", "fieldLayout", "signerLayout", "saveLabel", "cancelLabel"]);

type Context = { osfType?: string; baseType?: string; many: boolean; required: boolean; typeKey?: string };
type Edit = { start: number; end: number; text: string; tally?: [Map<string, number>, string] };

const { values: flags, positionals: roots } = (await import("node:util")).parseArgs({ allowPositionals: true, options: { "dry-run": { type: "boolean", default: false } } });

const files: string[] = [];
for (const root of roots) {
  for (const file of new Glob("**/*.{yaml,yml}").scanSync({ cwd: root, dot: false })) {
    if (/(^|\/)(node_modules|\.authoring-build|generated|dist|\.runtime)(\/|$)/.test(file)) continue;
    files.push(join(root, file));
  }
}

// The base type of every osfType: the core catalog and every plugin's.
const baseOf = new Map<string, string>();
for (const file of files.filter((path) => path.endsWith("catalogs/osf-types.yaml"))) {
  const types = (parseDocument(readFileSync(file, "utf8")).toJS() as { types?: Record<string, { baseType?: string }> })?.types ?? {};
  for (const [key, type] of Object.entries(types)) if (type?.baseType) baseOf.set(key, type.baseType);
}

const get = (map: YAMLMap, key: string): unknown => {
  const node = map.get(key, true) as Node | undefined;
  return isScalar(node) ? node.value : node;
};

function contextOf(map: YAMLMap, typeKey?: string): Context {
  const osfType = typeof get(map, "osfType") === "string" ? get(map, "osfType") as string : typeKey;
  const baseType = typeof get(map, "baseType") === "string" ? get(map, "baseType") as string : osfType ? baseOf.get(osfType) ?? osfType : undefined;
  const cardinality = get(map, "cardinality");
  const many = cardinality === "collection" || cardinality === "many" || (isMap(cardinality) && (cardinality as YAMLMap).get("max") !== 1);
  const required = get(map, "required") === true;
  return { osfType, baseType, many, required, typeKey };
}

/** The Figma field this use of an old name draws today. */
function target(name: string, context: Context): string | undefined {
  if (RENAMED[name]) return RENAMED[name];
  if (name === "ReferenceSelect") return context.many ? "FieldMultipleRelatedRecords" : "FieldSingleRelatedRecord";
  const generic = GENERIC[name];
  if (!generic) return undefined;
  const type = context.osfType;
  // A native type draws its own field under any of the generic widgets; the
  // widget decides only for the plain base type, which Input draws natively too.
  const native = type && NATIVE[type] && (type !== context.baseType || name === "Input" || name === "TextDisplay") ? NATIVE[type] : undefined;
  const drawn = native ?? generic;
  return drawn === "boolean" ? (context.required ? "FieldBoolean" : "FieldNullableBoolean") : drawn;
}

const labelWidth = (pixels: number) => (pixels < 192 ? "128" : pixels < 320 ? "256" : "384");

const report = { files: 0, occurrences: 0, components: new Map<string, number>(), props: new Map<string, number>() };
const count = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
/** Counts an edit once it is applied. */
const tag = (edits: Edit[], map: Map<string, number>, key: string) => { edits[edits.length - 1]!.tally = [map, key]; };

function quoteLike(source: string, text: string): string {
  return source.startsWith('"') ? JSON.stringify(text) : source.startsWith("'") ? `'${text}'` : text;
}

/** Removes a pair: its whole line(s) in a block map, the pair and one comma in a flow map. */
function removePair(source: string, map: YAMLMap, pair: Pair, edits: Edit[]) {
  const key = pair.key as Node, value = pair.value as Node | null;
  let start = key.range![0];
  let end = value?.range ? value.range[1] : key.range![1];
  if (map.flow) {
    // The comma before the pair, or after it for the first; a pair next to another removed one waits for the next pass.
    const before = map.items.indexOf(pair) > 0 ? source.slice(0, start).match(/,\s*$/) : null;
    const after = before ? null : source.slice(end).match(/^\s*,\s*/);
    if (before) start -= before[0].length;
    else if (after) end += after[0].length;
  } else {
    start = source.lastIndexOf("\n", start - 1) + 1;
    const newline = source.indexOf("\n", end);
    end = newline === -1 ? source.length : newline + 1;
  }
  edits.push({ start, end, text: "" });
}

function rewriteProps(source: string, props: YAMLMap, component: string, edits: Edit[], file: string) {
  const keys = new Set(props.items.map((pair) => String((pair.key as Node & { value?: unknown }).value ?? pair.key)));
  for (const pair of props.items) {
    if (!isPair(pair) || !isScalar(pair.key)) continue;
    const key = String(pair.key.value);
    const keyNode = pair.key as Node;
    const keySource = source.slice(keyNode.range![0], keyNode.range![1]);
    if (DROPPED.has(key)) { removePair(source, props, pair, edits); tag(edits, report.props, `${key} (dropped)`); continue; }
    if (key === "frontLabelWidth") {
      const value = (pair.value as Node & { value?: unknown })?.value;
      if (typeof value !== "number") throw new Error(`${file}: frontLabelWidth ${String(value)} is no pixel width.`);
      if (keys.has("labelWidth")) { removePair(source, props, pair, edits); continue; }
      edits.push({ start: keyNode.range![0], end: keyNode.range![1], text: quoteLike(keySource, "labelWidth") });
      const valueNode = pair.value as Node;
      edits.push({ start: valueNode.range![0], end: valueNode.range![1], text: JSON.stringify(labelWidth(value)) });
      tag(edits, report.props, "frontLabelWidth -> labelWidth");
      continue;
    }
    const renamed = COMPONENT_TEXTS[component]?.[key] ?? TEXTS[key];
    if (!renamed) continue;
    // The later of two texts for one slot won in the old renderer: searchPlaceholder over placeholder.
    if (keys.has(renamed) && renamed !== "placeholder") throw new Error(`${file}: ${component} has both ${key} and ${renamed}.`);
    edits.push({ start: keyNode.range![0], end: keyNode.range![1], text: quoteLike(keySource, renamed) });
    tag(edits, report.props, `${key} -> ${renamed}`);
  }
  if (keys.has("searchPlaceholder") && keys.has("placeholder")) {
    const shadowed = props.items.find((pair) => isScalar(pair.key) && pair.key.value === "placeholder");
    if (shadowed) { removePair(source, props, shadowed as Pair, edits); tag(edits, report.props, "placeholder (shadowed by searchPlaceholder)"); }
  }
}

/** Rewrites one component name scalar and the props it takes. */
function rewriteUse(source: string, node: Node, props: unknown, context: Context, edits: Edit[], file: string) {
  if (!isScalar(node) || typeof node.value !== "string") return;
  const name = node.value;
  const next = target(name, context) ?? name;
  if (next !== name) {
    edits.push({ start: node.range![0], end: node.range![1], text: quoteLike(source.slice(node.range![0], node.range![1]), next) });
    tag(edits, report.components, `${name} -> ${next}`);
  }
  if (isMap(props)) rewriteProps(source, props as YAMLMap, next, edits, file);
}

function visit(source: string, node: unknown, edits: Edit[], file: string, path: string[]) {
  if (isSeq(node)) { for (const item of node.items) visit(source, item, edits, file, path); return; }
  if (!isMap(node)) return;
  const map = node as YAMLMap;
  const key = path[path.length - 1];
  // An osf type (`types.<name>`) is the type its fields take; a catalog default (`defaults.<baseType>`) the base type.
  const typeKey = path.length >= 2 && (path[path.length - 2] === "types" || path[path.length - 2] === "defaults") ? key : undefined;
  const render = map.get("render", true);
  if (isMap(render)) {
    const renderMap = render as YAMLMap;
    const context = contextOf(map, typeKey);
    const component = renderMap.get("component", true) as Node | undefined;
    if (component) rewriteUse(source, component, renderMap.get("props", true), context, edits, file);
    // An osf type names its input and display; its props apply to both.
    for (const role of ["input", "display"] as const) {
      const named = renderMap.get(role, true) as Node | undefined;
      if (named) rewriteUse(source, named, undefined, context, edits, file);
    }
    const typeProps = map.get("props", true);
    if (!component && isMap(typeProps)) {
      const input = renderMap.get("input");
      rewriteProps(source, typeProps as YAMLMap, typeof input === "string" ? target(input, context) ?? input : "", edits, file);
    }
  } else if (map.get("component", true) && key !== "render") {
    // A catalog default, its `required` variant, or a field that names its component directly.
    const variant = key === "required" && path.length >= 3 && path[path.length - 3] === "defaults";
    const context = variant ? { ...contextOf(map, path[path.length - 2]), required: true } : contextOf(map, typeKey);
    rewriteUse(source, map.get("component", true) as Node, map.get("props", true), context, edits, file);
  }
  for (const pair of map.items) {
    if (!isPair(pair)) continue;
    const child = isScalar(pair.key) ? String(pair.key.value) : "";
    if (child === "render") continue;
    visit(source, pair.value, edits, file, [...path, child]);
  }
}

function rewrite(file: string, source: string): string {
  const edits: Edit[] = [];
  for (const doc of parseAllDocuments(source)) {
    if (doc.errors.length) throw new Error(`${file}: ${doc.errors[0]!.message}`);
    visit(source, doc.contents, edits, file, []);
  }
  // Apply from the end; an edit that overlaps one already applied is left for the next pass.
  let text = source, floor = Infinity;
  const unique = [...new Map(edits.map((edit) => [`${edit.start}:${edit.end}`, edit])).values()].sort((a, b) => b.start - a.start || b.end - a.end);
  for (const edit of unique) {
    if (edit.end > floor) continue;
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    floor = edit.start;
    if (edit.tally) count(...edit.tally);
    report.occurrences++;
  }
  return text;
}

for (const file of files) {
  const source = readFileSync(file, "utf8");
  if (!/component|render|frontLabelWidth|spacing|inputTone/.test(source)) continue;
  let text = source;
  for (let pass = 0; ; pass++) {
    const next = rewrite(file, text);
    if (next === text) break;
    if (pass > 10) throw new Error(`${file}: no fixed point.`);
    text = next;
  }
  if (text === source) continue;
  parseDocument(text, { prettyErrors: true });
  report.files++;
  console.log(relative(process.cwd(), file));
  if (!flags["dry-run"]) writeFileSync(file, text);
}

console.log(`\n${report.files} files, ${report.occurrences} edits`);
for (const [key, n] of [...report.components].sort()) console.log(`  component ${key}: ${n}`);
for (const [key, n] of [...report.props].sort()) console.log(`  prop ${key}: ${n}`);
