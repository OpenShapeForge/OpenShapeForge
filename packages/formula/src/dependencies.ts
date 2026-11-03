// SPDX-License-Identifier: BUSL-1.1
import type { CompilerExpressionInput } from "./canonical/canonical-condition.ts";
import type { DependencyNode } from "./graph.ts";
import type { FormulaAst, FormulaFieldRef } from "./types.ts";

/** The direct sub-expressions of a canonical AST node, of any kind, in the order formula text writes them. */
export function childExpressions(node: CompilerExpressionInput): CompilerExpressionInput[] {
  const n = node as Record<string, unknown>;
  const children: unknown[] = [];
  for (const key of ["left", "right", "condition", "then", "else", "subject"]) {
    if (n[key] !== undefined) children.push(n[key]);
  }
  for (const key of ["operands", "conditions", "all", "any"]) {
    if (Array.isArray(n[key])) children.push(...(n[key] as unknown[]));
  }
  if (Array.isArray(n.cases)) {
    for (const entry of n.cases as Array<{ when: unknown; then: unknown }>) children.push(entry.when, entry.then);
  }
  for (const key of ["default", "where", "of"]) {
    if (n[key] !== undefined) children.push(n[key]);
  }
  return children.filter((child): child is CompilerExpressionInput => typeof child === "object" && child !== null);
}

/**
 * The fields a formula reads, each once, in order of first appearance: its
 * own fields with scope `self`, an owned child's with scope `{ relation }`.
 */
export function dependencies(ast: FormulaAst): FormulaFieldRef[] {
  const found: FormulaFieldRef[] = [];
  const seen = new Set<string>();
  const visit = (node: CompilerExpressionInput): void => {
    if ((node as { kind?: string }).kind === "path") {
      const path = (node as { path: string }).path;
      if (!seen.has(path)) {
        seen.add(path);
        const dot = path.indexOf(".");
        found.push(dot < 0 ? { id: path, scope: "self" } : { id: path.slice(dot + 1), scope: { relation: path.slice(0, dot) } });
      }
      return;
    }
    childExpressions(node).forEach(visit);
  };
  visit(ast);
  return found;
}

/**
 * Graph nodes for what a formula on `entity` reads: its own fields on
 * `entity`, an owned child's on the child entity `relations` names. A
 * relation `relations` does not know is kept under its own name, so the gap
 * shows rather than disappears.
 */
export function dependencyNodes(
  entity: string,
  refs: readonly FormulaFieldRef[],
  relations: Readonly<Record<string, string>> = {},
): DependencyNode[] {
  return refs.map((ref) => ({
    entity: ref.scope === "self" ? entity : (relations[ref.scope.relation] ?? ref.scope.relation),
    field: ref.id,
  }));
}
