// SPDX-License-Identifier: BUSL-1.1
/**
 * The one reader of a display template (`"{{code}} {{ledgerAccount.code || name}}"`):
 * an entity's `displayTemplate`, a record page title, a picker label. A
 * placeholder holds one or more dotted record paths separated by `||`, the
 * first one with a value wins. The same parser yields the GraphQL selection
 * a list query needs for the template and the rendered text for a record.
 */

const PLACEHOLDER = /\{\{(.+?)\}\}/g;
const SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Every path a template reads, in order of appearance, as segments. */
export function templatePaths(template: string | undefined): string[][] {
  if (!template) return [];
  const paths: string[][] = [];
  const seen = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    for (const candidate of match[1]!.split("||")) {
      const segments = candidate.trim().split(".");
      if (!segments.every((segment) => SEGMENT.test(segment))) continue;
      const key = segments.join(".");
      if (seen.has(key)) continue;
      seen.add(key);
      paths.push(segments);
    }
  }
  return paths;
}

type SelectionTree = Map<string, SelectionTree>;

function renderSelection(tree: SelectionTree): string {
  return [...tree.entries()]
    .map(([field, children]) => (children.size > 0 ? `${field} { ${renderSelection(children)} }` : field))
    .join(" ");
}

/**
 * A GraphQL selection set covering every template path plus `id`, with a
 * nested path selected as a nested object (`ledgerAccount { code }`). Every
 * token is a validated identifier, so the result is safe to interpolate.
 */
export function templateSelection(template: string | undefined, extra: readonly string[] = []): string {
  const tree: SelectionTree = new Map();
  const add = (segments: readonly string[]) => {
    let current = tree;
    for (const segment of segments) {
      const next = current.get(segment) ?? new Map();
      current.set(segment, next);
      current = next;
    }
  };
  add(["id"]);
  for (const segment of extra) if (SEGMENT.test(segment)) add([segment]);
  for (const path of templatePaths(template)) add(path);
  return renderSelection(tree);
}

function valueAt(record: unknown, segments: readonly string[]): unknown {
  let current: unknown = record;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** The template rendered for one record; an empty result falls back to the record's id. */
export function renderTemplate(template: string | undefined, record: Record<string, unknown>): string {
  const rendered = (template ?? "")
    .replace(PLACEHOLDER, (_, expression: string) => {
      for (const candidate of expression.split("||")) {
        const value = valueAt(record, candidate.trim().split(".").filter(Boolean));
        if (value != null && value !== "" && typeof value !== "object") return String(value);
      }
      return "";
    })
    .replace(/\s+/g, " ")
    .trim();
  return rendered || String(record.id ?? "");
}
