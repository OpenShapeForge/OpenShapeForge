// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Kind, parse, print } from "graphql";
import { glob } from "glob";
import ts from "typescript";
import type { GeneratedArtifact } from "./schema.js";

type StringBindings = Map<ts.Node, Map<string, ts.Expression>>;

function lexicalScope(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node;
  while (
    current &&
    !ts.isSourceFile(current) &&
    !ts.isFunctionLike(current) &&
    !ts.isBlock(current)
  ) {
    current = current.parent;
  }
  return current ?? node.getSourceFile();
}

function resolveBinding(bindings: StringBindings, node: ts.Node, name: string) {
  let current: ts.Node | undefined = node;
  while (current) {
    const value = bindings.get(lexicalScope(current))?.get(name);
    if (value) return value;
    current = lexicalScope(current).parent;
  }
  return undefined;
}

function combine(parts: string[][]): string[] {
  return parts.reduce<string[]>(
    (prefixes, values) =>
      prefixes.flatMap((prefix) => values.map((value) => prefix + value)),
    [""],
  );
}

function evaluateString(
  expression: ts.Expression,
  bindings: StringBindings,
  seen = new Set<ts.Expression>(),
): string[] {
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression)
  ) {
    return evaluateString(expression.expression, bindings, seen);
  }
  if (ts.isIdentifier(expression)) {
    const value = resolveBinding(bindings, expression, expression.text);
    if (!value) return [];
    if (seen.has(value)) return [];
    return evaluateString(value, bindings, new Set([...seen, value]));
  }
  if (ts.isTemplateExpression(expression)) {
    const parts: string[][] = [[expression.head.text]];
    for (const span of expression.templateSpans) {
      const values = evaluateString(span.expression, bindings, seen);
      if (values.length === 0) return [];
      parts.push(values.map((value) => value + span.literal.text));
    }
    return combine(parts);
  }
  if (ts.isConditionalExpression(expression)) {
    return [
      ...evaluateString(expression.whenTrue, bindings, seen),
      ...evaluateString(expression.whenFalse, bindings, seen),
    ];
  }
  if (ts.isBinaryExpression(expression)) {
    if (expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = evaluateString(expression.left, bindings, seen);
      const right = evaluateString(expression.right, bindings, seen);
      return left.length && right.length ? combine([left, right]) : [];
    }
    if (
      expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
    ) {
      return [
        ...evaluateString(expression.left, bindings, seen),
        ...evaluateString(expression.right, bindings, seen),
      ];
    }
  }
  return [];
}

function canonicalOperation(candidate: string): string | null {
  try {
    const document = parse(candidate);
    if (
      !document.definitions.some(
        (definition) => definition.kind === Kind.OPERATION_DEFINITION,
      )
    ) {
      return null;
    }
    return print(document);
  } catch {
    return null;
  }
}

function collectSourceOperations(
  sourceName: string,
  contents: string,
  output: Set<string>,
): void {
  const source = ts.createSourceFile(
    sourceName,
    contents,
    ts.ScriptTarget.Latest,
    true,
    sourceName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const bindings: StringBindings = new Map();
  source.forEachChild(function collectBindings(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const scope = lexicalScope(node);
      const scoped = bindings.get(scope) ?? new Map<string, ts.Expression>();
      scoped.set(node.name.text, node.initializer);
      bindings.set(scope, scoped);
    }
    node.forEachChild(collectBindings);
  });
  source.forEachChild(function visit(node) {
    const expressions: ts.Expression[] = [];
    if (ts.isVariableDeclaration(node) && node.initializer)
      expressions.push(node.initializer);
    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === "query") ||
        (ts.isStringLiteral(node.name) && node.name.text === "query"))
    ) {
      expressions.push(node.initializer);
    }
    for (const expression of expressions) {
      for (const value of evaluateString(expression, bindings)) {
        const operation = canonicalOperation(value);
        if (operation) output.add(operation);
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "executeGraphqlRequest"
    ) {
      const input = node.arguments[0];
      if (input && ts.isObjectLiteralExpression(input)) {
        const property = (name: string): ts.Expression | undefined => {
          const entry = input.properties.find(
            (candidate) =>
              ((ts.isPropertyAssignment(candidate) ||
                ts.isShorthandPropertyAssignment(candidate)) &&
                ts.isIdentifier(candidate.name) &&
                candidate.name.text === name) ||
              (ts.isPropertyAssignment(candidate) &&
                ts.isStringLiteral(candidate.name) &&
                candidate.name.text === name),
          );
          if (!entry) return undefined;
          if (ts.isPropertyAssignment(entry)) return entry.initializer;
          return ts.isShorthandPropertyAssignment(entry)
            ? resolveBinding(bindings, entry, entry.name.text)
            : undefined;
        };
        const profile = property("profile");
        const isIntegration =
          profile &&
          ts.isStringLiteralLike(profile) &&
          profile.text === "integration";
        const isManifestBound =
          profile &&
          ts.isStringLiteralLike(profile) &&
          profile.text === "persisted";
        const query = property("query");
        const supported = query
          ? evaluateString(query, bindings).some((value) =>
              canonicalOperation(value),
            )
          : false;
        if (!isIntegration && !isManifestBound && !supported) {
          const { line } = source.getLineAndCharacterOfPosition(
            node.getStart(source),
          );
          throw new Error(
            `${sourceName}:${line + 1} uses a non-static first-party GraphQL operation; ` +
              `make it build-time evaluable or set profile: "integration" deliberately.`,
          );
        }
      }
    }
    node.forEachChild(visit);
  });
}

function collectConfigOperations(value: unknown, output: Set<string>): void {
  if (typeof value === "string") {
    const operation = canonicalOperation(value);
    if (operation) output.add(operation);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectConfigOperations(entry, output);
    return;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value))
      collectConfigOperations(entry, output);
  }
}

function manifestContents(operations: Set<string>): string {
  const entries = [...operations]
    .map(
      (query) =>
        [createHash("sha256").update(query).digest("hex"), query] as const,
    )
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const operationNames = [
    ...new Set(
      entries.flatMap(([, query]) =>
        parse(query).definitions.flatMap((definition) =>
          definition.kind === Kind.OPERATION_DEFINITION && definition.name
            ? [definition.name.value]
            : [],
        ),
      ),
    ),
  ].sort();
  const store = Object.fromEntries(entries);
  const checksum = createHash("sha256")
    .update(JSON.stringify(store))
    .digest("hex");
  return `${JSON.stringify({ version: 1, checksum, operationNames, operations: store }, null, 2)}\n`;
}

export async function generatePersistedOperationArtifacts(input: {
  repoRoot: string;
  generatedWebSources: ReadonlyMap<string, string>;
  pageConfigs: unknown;
}): Promise<GeneratedArtifact[]> {
  const operations = new Set<string>();
  const checkedInSources = await glob(
    ["apps/web/src/**/*.{ts,tsx}", "examples/plugins/*/web/**/*.{ts,tsx}"],
    {
      cwd: input.repoRoot,
      nodir: true,
      ignore: [
        "apps/web/src/compiler/**",
        "apps/web/src/generated/**",
        "apps/web/src/app/(generated)/**",
        "apps/web/src/actions/generated/**",
      ],
    },
  );
  for (const path of checkedInSources.sort()) {
    collectSourceOperations(
      path,
      await readFile(join(input.repoRoot, path), "utf8"),
      operations,
    );
  }
  for (const [path, contents] of [...input.generatedWebSources].sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  )) {
    if (path.endsWith(".ts") || path.endsWith(".tsx")) {
      collectSourceOperations(path, contents, operations);
    }
  }
  collectConfigOperations(input.pageConfigs, operations);
  const contents = manifestContents(operations);
  return [
    {
      path: "apps/api/src/generated/graphql/persisted-operations.json",
      contents,
    },
    { path: "apps/web/src/generated/persisted-operations.json", contents },
  ];
}

/** API-only hosts still need the runtime's unconditional persisted-operation import. */
export function renderEmptyApiPersistedOperationArtifact(): GeneratedArtifact {
  return {
    path: "apps/api/src/generated/graphql/persisted-operations.json",
    contents: manifestContents(new Set()),
  };
}
