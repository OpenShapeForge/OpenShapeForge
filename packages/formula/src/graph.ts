// SPDX-License-Identifier: BUSL-1.1
// The dependency graph over computed fields. Nodes are `(entity, field)`;
// an edge runs from a definition to every node it reads. Formulas only add
// edges within a record and to owned children, but nothing here assumes that:
// lookups and rollups add edges across entities with the same shape.

export type DependencyNode = { entity: string; field: string };

export type DependencyDefinition = {
  node: DependencyNode;
  dependsOn: readonly DependencyNode[];
};

export type DependencyGraph = {
  /** Every definition outside a cycle, each after every definition it reads. Stable for a given input order. */
  readonly order: readonly DependencyNode[];
  /** Each group of definitions that reads itself, in input order. */
  readonly cycles: readonly (readonly DependencyNode[])[];
  /** The definitions to recompute when `changed` changes, transitively, in evaluation order. */
  affectedBy(changed: readonly DependencyNode[]): DependencyNode[];
  /** A chain of reads from `from` to `to` (both included), if `from` reads `to` directly or indirectly. */
  path(from: DependencyNode, to: DependencyNode): DependencyNode[] | undefined;
};

export function dependencyNodeKey(node: DependencyNode): string {
  return JSON.stringify([node.entity, node.field]);
}

/**
 * Builds the graph over `definitions`. A node defined twice keeps its last
 * definition. A node that is read but not defined (a stored field) is a leaf.
 */
export function buildDependencyGraph(definitions: readonly DependencyDefinition[]): DependencyGraph {
  const defined = new Map<string, DependencyDefinition>();
  for (const definition of definitions) {
    const key = dependencyNodeKey(definition.node);
    defined.delete(key);
    defined.set(key, definition);
  }
  const edges = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  const nodes = new Map<string, DependencyNode>();
  for (const [key, definition] of defined) {
    nodes.set(key, definition.node);
    const reads = [...new Set(definition.dependsOn.map(dependencyNodeKey))];
    edges.set(key, reads);
    definition.dependsOn.forEach((node) => {
      const read = dependencyNodeKey(node);
      if (!nodes.has(read)) nodes.set(read, node);
    });
    for (const read of reads) {
      const list = dependents.get(read) ?? [];
      list.push(key);
      dependents.set(read, list);
    }
  }

  // Tarjan's strongly connected components over the defined nodes.
  const indexOf = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;
  const connect = (key: string): void => {
    indexOf.set(key, counter);
    lowLink.set(key, counter);
    counter += 1;
    stack.push(key);
    onStack.add(key);
    for (const read of edges.get(key) ?? []) {
      if (!defined.has(read)) continue;
      if (!indexOf.has(read)) {
        connect(read);
        lowLink.set(key, Math.min(lowLink.get(key)!, lowLink.get(read)!));
      } else if (onStack.has(read)) {
        lowLink.set(key, Math.min(lowLink.get(key)!, indexOf.get(read)!));
      }
    }
    if (lowLink.get(key) === indexOf.get(key)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== key);
      components.push(component);
    }
  };
  for (const key of defined.keys()) if (!indexOf.has(key)) connect(key);

  const inputOrder = new Map([...defined.keys()].map((key, index) => [key, index]));
  const cyclic = new Set<string>();
  const cycles: DependencyNode[][] = [];
  for (const component of components) {
    const selfLoop = component.length === 1 && (edges.get(component[0]!) ?? []).includes(component[0]!);
    if (component.length < 2 && !selfLoop) continue;
    component.sort((a, b) => inputOrder.get(a)! - inputOrder.get(b)!);
    component.forEach((key) => cyclic.add(key));
    cycles.push(component.map((key) => nodes.get(key)!));
  }
  cycles.sort((a, b) => inputOrder.get(dependencyNodeKey(a[0]!))! - inputOrder.get(dependencyNodeKey(b[0]!))!);

  // Depth-first post-order in input order: dependencies land before their readers.
  const ordered: string[] = [];
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visited.has(key)) return;
    visited.add(key);
    for (const read of edges.get(key) ?? []) if (defined.has(read) && !cyclic.has(read)) visit(read);
    ordered.push(key);
  };
  for (const key of defined.keys()) if (!cyclic.has(key)) visit(key);
  const position = new Map(ordered.map((key, index) => [key, index]));

  return {
    order: ordered.map((key) => nodes.get(key)!),
    cycles,
    affectedBy(changed) {
      const reached = new Set<string>();
      const queue = changed.map(dependencyNodeKey);
      while (queue.length > 0) {
        const key = queue.shift()!;
        for (const reader of dependents.get(key) ?? []) {
          if (reached.has(reader)) continue;
          reached.add(reader);
          queue.push(reader);
        }
      }
      return [...reached]
        .filter((key) => position.has(key))
        .sort((a, b) => position.get(a)! - position.get(b)!)
        .map((key) => nodes.get(key)!);
    },
    path(from, to) {
      const target = dependencyNodeKey(to);
      const seen = new Set<string>();
      const walk = (key: string, trail: string[]): string[] | undefined => {
        if (seen.has(key)) return undefined;
        seen.add(key);
        for (const read of edges.get(key) ?? []) {
          if (read === target) return [...trail, read];
          const found = walk(read, [...trail, read]);
          if (found) return found;
        }
        return undefined;
      };
      const start = dependencyNodeKey(from);
      const found = walk(start, [start]);
      return found?.map((key) => nodes.get(key)!);
    },
  };
}
