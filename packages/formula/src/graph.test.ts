// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";

import { env } from "./__fixtures__/env.ts";
import { dependencies, dependencyNodes } from "./dependencies.ts";
import { analyze } from "./editor.ts";
import { buildDependencyGraph, type DependencyDefinition, type DependencyNode } from "./graph.ts";

const P = (field: string): DependencyNode => ({ entity: "Product", field });
const define = (field: string, ...reads: DependencyNode[]): DependencyDefinition => ({ node: P(field), dependsOn: reads });
const names = (nodes: readonly DependencyNode[]) => nodes.map((node) => `${node.entity}.${node.field}`);

describe("topological order", () => {
  test("every definition comes after what it reads, regardless of input order", () => {
    const graph = buildDependencyGraph([
      define("margin", P("gross"), P("cost")),
      define("gross", P("net"), P("vat")),
      define("net", P("capacity"), P("price")),
      define("vat", P("net")),
    ]);
    expect(names(graph.order)).toEqual(["Product.net", "Product.vat", "Product.gross", "Product.margin"]);
    expect(graph.cycles).toEqual([]);
  });

  test("independent definitions keep their input order", () => {
    const graph = buildDependencyGraph([define("b", P("x")), define("a", P("y")), define("c", P("b"))]);
    expect(names(graph.order)).toEqual(["Product.b", "Product.a", "Product.c"]);
  });

  test("edges across entities order the same way (what 1c adds)", () => {
    const graph = buildDependencyGraph([
      { node: P("total"), dependsOn: [{ entity: "ProductPricing", field: "net" }, P("capacity")] },
      { node: { entity: "ProductPricing", field: "net" }, dependsOn: [{ entity: "ProductPricing", field: "amount" }] },
    ]);
    expect(names(graph.order)).toEqual(["ProductPricing.net", "Product.total"]);
  });

  test("a later definition of the same node replaces the earlier one", () => {
    const graph = buildDependencyGraph([define("a", P("b")), define("b"), define("a")]);
    expect(names(graph.order)).toEqual(["Product.b", "Product.a"]);
  });
});

describe("cycle detection", () => {
  test("a self-reference is a cycle", () => {
    const graph = buildDependencyGraph([define("a", P("a")), define("b", P("x"))]);
    expect(graph.cycles.map(names)).toEqual([["Product.a"]]);
    expect(names(graph.order)).toEqual(["Product.b"]);
  });

  test("longer cycles are reported once each, members in input order", () => {
    const graph = buildDependencyGraph([
      define("a", P("b")),
      define("b", P("c")),
      define("c", P("a")),
      define("d", P("e")),
      define("e", P("d")),
      define("f", P("a")),
    ]);
    expect(graph.cycles.map(names)).toEqual([
      ["Product.a", "Product.b", "Product.c"],
      ["Product.d", "Product.e"],
    ]);
    expect(names(graph.order)).toEqual(["Product.f"]);
  });

  test("path finds the chain of reads", () => {
    const graph = buildDependencyGraph([define("a", P("b")), define("b", P("c")), define("c", P("a"))]);
    expect(names(graph.path(P("b"), P("a"))!)).toEqual(["Product.b", "Product.c", "Product.a"]);
    expect(names(graph.path(P("a"), P("a"))!)).toEqual(["Product.a", "Product.b", "Product.c", "Product.a"]);
    expect(graph.path(P("a"), P("zzz"))).toBeUndefined();
  });

  test("diamonds are not cycles", () => {
    const graph = buildDependencyGraph([define("top", P("l"), P("r")), define("l", P("base")), define("r", P("base")), define("base")]);
    expect(graph.cycles).toEqual([]);
    expect(names(graph.order)).toEqual(["Product.base", "Product.l", "Product.r", "Product.top"]);
  });
});

describe("what a write touches", () => {
  const graph = buildDependencyGraph([
    define("net", P("capacity"), P("price")),
    define("gross", P("net"), P("vat")),
    define("label", P("title")),
    { node: P("total"), dependsOn: [{ entity: "ProductPricing", field: "amount" }, P("gross")] },
  ]);

  test("a stored field recomputes its readers transitively, in evaluation order", () => {
    expect(names(graph.affectedBy([P("price")]))).toEqual(["Product.net", "Product.gross", "Product.total"]);
    expect(names(graph.affectedBy([P("title")]))).toEqual(["Product.label"]);
    expect(graph.affectedBy([P("unrelated")])).toEqual([]);
  });

  test("a write on an owned child recomputes the owner's formulas", () => {
    expect(names(graph.affectedBy([{ entity: "ProductPricing", field: "amount" }]))).toEqual(["Product.total"]);
  });
});

describe("dependencies from an AST", () => {
  test("self and owned-child references, once each", () => {
    const ast = analyze("IF({Active}, {Capacity kWh} * pricing.amount, {Capacity kWh})", env).ast!;
    expect(dependencies(ast)).toEqual([
      { id: "f-active", scope: "self" },
      { id: "f-cap", scope: "self" },
      { id: "amount", scope: { relation: "pricing" } },
    ]);
  });

  test("reach into every node kind", () => {
    const ast = analyze(
      "SWITCH({Category}, {Title}, DATEADD({Launch date}, {Capacity kWh}, 'hours'), {Last seen}) = BLANK()",
      env,
    ).ast!;
    expect(dependencies(ast).map((ref) => ref.id)).toEqual(["category", "title", "f-launch", "f-cap", "f-seen"]);
  });

  test("dependencyNodes maps relations to the child entity", () => {
    const refs = dependencies(analyze("{Capacity kWh} * pricing.amount", env).ast!);
    expect(dependencyNodes("Product", refs, { pricing: "ProductPricing" })).toEqual([
      { entity: "Product", field: "f-cap" },
      { entity: "ProductPricing", field: "amount" },
    ]);
    expect(dependencyNodes("Product", refs)[1]).toEqual({ entity: "pricing", field: "amount" });
  });
});
