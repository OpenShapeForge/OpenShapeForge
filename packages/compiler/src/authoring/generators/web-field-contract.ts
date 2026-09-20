// SPDX-License-Identifier: BUSL-1.1
/**
 * The renderer's copy of the field contract.
 *
 * `apps/web` types every rendered field against the compiler's own `Field`
 * and `OsfTypeDefinition` declarations, but it cannot import the compiler
 * package: Next resolves under a bundler and the compiler's NodeNext
 * specifiers do not survive that. So the declarations are copied, verbatim,
 * out of `packages/compiler/src/authoring/types/*.ts` into one generated
 * module the web app imports as `@/generated/compiler/field-contract`.
 *
 * The whitelist below is the contract: only these declarations are copied,
 * and the copy must stand on its own (see `assertContractIsSelfContained`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TYPES_DIR = join(import.meta.dirname, "../types");

type ContractDeclaration = { kind: "interface" | "type"; name: string };

const CONTRACT_DECLARATIONS: readonly ContractDeclaration[] = [
  { kind: "interface", name: "LocalizedText" },
  { kind: "interface", name: "ValidationRule" },
  { kind: "interface", name: "FieldValidation" },
  { kind: "interface", name: "FieldReference" },
  { kind: "interface", name: "FieldPersisted" },
  { kind: "interface", name: "FieldRender" },
  { kind: "interface", name: "FieldPermissions" },
  { kind: "interface", name: "FieldAuthorizationRoles" },
  { kind: "interface", name: "FieldAuthorizationConfig" },
  { kind: "interface", name: "VisibilityCondition" },
  { kind: "interface", name: "VisibilityConfig" },
  { kind: "interface", name: "ComputedField" },
  { kind: "interface", name: "FieldOptionStatic" },
  { kind: "interface", name: "FieldOptions" },
  { kind: "interface", name: "OsfTypeLookupDefinition" },
  { kind: "interface", name: "DataClassification" },
  { kind: "interface", name: "RetentionPolicy" },
  { kind: "interface", name: "ContextHints" },
  { kind: "type", name: "FieldDefinitionValueType" },
  { kind: "type", name: "FieldDefinitionCardinality" },
  { kind: "type", name: "FieldDefinitionVariableMode" },
  { kind: "type", name: "FieldDefinitionEqualityConstraint" },
  { kind: "type", name: "FieldDefinitionRelationshipConstraints" },
  { kind: "type", name: "FieldDefinitionValidation" },
  { kind: "interface", name: "FieldDefinitionSuggestions" },
  { kind: "interface", name: "FieldDefinitionInverseCollection" },
  { kind: "interface", name: "FieldDefinitionRelationship" },
  { kind: "interface", name: "FieldDefinitionProvider" },
  { kind: "interface", name: "FieldDefinitionTransitionWrite" },
  { kind: "type", name: "FieldDefinitionTransitionPrecondition" },
  { kind: "interface", name: "FieldDefinitionTransitionRule" },
  { kind: "interface", name: "FieldDefinitionTransitions" },
  { kind: "interface", name: "FieldDefinitionDeriveOnCreate" },
  { kind: "interface", name: "FieldDefinitionRuntimeMetadata" },
  { kind: "interface", name: "FieldDefinitionWorkflowInspector" },
  { kind: "interface", name: "FieldDefinitionAuthoringMetadata" },
  { kind: "interface", name: "FieldDefinition" },
  { kind: "type", name: "OsfTypeSchemaReference" },
  { kind: "interface", name: "OsfTypeDefinition" },
  { kind: "type", name: "FieldSuggestions" },
  { kind: "type", name: "FieldRelationship" },
  { kind: "type", name: "FieldRuntimeMetadata" },
  { kind: "type", name: "FieldWorkflowInspector" },
  { kind: "type", name: "FieldCardinality" },
  { kind: "type", name: "FieldAuthoringMetadata" },
  { kind: "interface", name: "Field" },
];

/** All type source files concatenated, so extraction works across the split modules. */
function readTypeSource(): string {
  return readdirSync(TYPES_DIR)
    .filter((file) => file.endsWith(".ts") && file !== "index.ts")
    .sort()
    .map((file) => readFileSync(join(TYPES_DIR, file), "utf-8"))
    .join("\n");
}

const OPENERS = new Set(["{", "(", "["]);
const CLOSERS = new Set(["}", ")", "]"]);

/** A `type X = …;` ends at the first `;` outside any bracket. */
function typeAliasEnd(source: string, start: number, name: string): number {
  const equals = source.indexOf("=", start);
  if (equals === -1) throw new Error(`Unable to find equals sign for type ${name}`);
  let depth = 0;
  for (let index = equals + 1; index < source.length; index += 1) {
    const char = source[index]!;
    if (OPENERS.has(char)) depth += 1;
    else if (CLOSERS.has(char)) depth -= 1;
    else if (char === ";" && depth === 0) return index + 1;
  }
  throw new Error(`Unable to find semicolon for type ${name}`);
}

/** An `interface X { … }` ends at its matching brace, plus a trailing `;` if any. */
function interfaceEnd(source: string, start: number, name: string): number {
  const firstBrace = source.indexOf("{", start);
  if (firstBrace === -1) throw new Error(`Unable to find opening brace for interface ${name}`);
  let depth = 0;
  for (let index = firstBrace; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        let cursor = index + 1;
        while (cursor < source.length && /\s/.test(source[cursor] ?? "")) cursor += 1;
        return source[cursor] === ";" ? cursor + 1 : index + 1;
      }
    }
  }
  throw new Error(`Unable to find closing brace for interface ${name}`);
}

function extractExportBlock(source: string, declaration: ContractDeclaration): string {
  const match = new RegExp(`export\\s+${declaration.kind}\\s+${declaration.name}\\b`).exec(source);
  if (!match) {
    throw new Error(`Unable to find ${declaration.kind} ${declaration.name} in compiler types source`);
  }
  const end = declaration.kind === "type"
    ? typeAliasEnd(source, match.index, declaration.name)
    : interfaceEnd(source, match.index, declaration.name);
  return source.slice(match.index, end).trim();
}

/**
 * The copy must stand on its own: a whitelisted declaration that names an
 * exported type the whitelist leaves out compiles here and breaks in the web
 * app's typecheck. Fail at generate time instead, naming the omission.
 */
function assertContractIsSelfContained(typeSource: string, declarations: string[]): void {
  const exported = new Set([...typeSource.matchAll(/^export\s+(?:interface|type)\s+(\w+)/gm)].map((match) => match[1]!));
  const emitted = new Set(CONTRACT_DECLARATIONS.map((declaration) => declaration.name));
  const missing = new Set<string>();
  for (const declaration of declarations) {
    for (const [identifier] of declaration.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "").matchAll(/\b[A-Z]\w*\b/g)) {
      if (exported.has(identifier) && !emitted.has(identifier)) missing.add(identifier);
    }
  }
  if (missing.size > 0) {
    throw new Error(
      `field-contract copy references ${[...missing].sort().join(", ")} without emitting it; ` +
        "add it to CONTRACT_DECLARATIONS in web-field-contract.ts.",
    );
  }
}

export function buildWebFieldContractSource(): string {
  const typeSource = readTypeSource();
  const declarations = CONTRACT_DECLARATIONS.map((declaration) => extractExportBlock(typeSource, declaration));
  assertContractIsSelfContained(typeSource, declarations);
  return [
    "// Generated by OpenShapeForge Service Compiler.",
    "// Source of truth: packages/compiler/src/authoring/types/*.ts",
    "// Do not edit manually.",
    "",
    ...declarations.flatMap((declaration) => [declaration, ""]),
  ].join("\n");
}
