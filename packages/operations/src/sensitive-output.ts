// SPDX-License-Identifier: BUSL-1.1
/** Interface-neutral disclosure policy for canonical JSON Schema output. */
export const PRIVATE_OUTPUT_TOOL_NAME = "osf_complete_private_operation";
type Schema = Record<string, unknown>;
const object = (v: unknown): v is Schema => v !== null && typeof v === "object" && !Array.isArray(v);
const privateNode = (s: Schema) => object(s["x-osf-classification"]) && s["x-osf-classification"].sensitivity === "confidential";

export function hasSensitiveOutput(schema: unknown): boolean {
  let nodes = 0;
  const scan = (node: unknown, depth: number): boolean => {
    if (!object(node)) return false;
    if (++nodes > 20_000 || depth > 32) throw new Error("Output disclosure schema exceeds its inspection bound.");
    if (Object.hasOwn(node, "x-osf-classification")) return true;
    return Object.entries(node).some(([key, value]) =>
      ["properties", "$defs", "definitions", "patternProperties", "dependentSchemas", "dependencies"].includes(key) && object(value)
        ? Object.values(value).some(v => scan(v, depth + 1))
        : ["items", "additionalProperties", "contains", "not", "if", "then", "else"].includes(key) && object(value)
          ? scan(value, depth + 1)
          : ["allOf", "anyOf", "oneOf", "prefixItems", "items"].includes(key) && Array.isArray(value)
            ? value.some(v => scan(v, depth + 1)) : false);
  };
  return scan(schema, 0);
}

/** Refuse ambiguous disclosure rules instead of accidentally returning a secret. */
export function assertSensitiveOutputSchema(schema: Schema): void {
  if (!hasSensitiveOutput(schema)) return;
  let nodes = 0;
  const visit = (s: Schema, depth = 0) => {
    if (++nodes > 20_000 || depth > 32) throw new Error("Output disclosure schema exceeds its inspection bound.");
    if (Object.keys(s).some(k => ["$ref", "$dynamicRef", "$recursiveRef", "dependencies", "allOf", "anyOf", "oneOf", "patternProperties", "dependentSchemas", "if", "then", "else", "not", "contains", "prefixItems"].includes(k))) {
      throw new Error("Sensitive output requires explicit object properties and homogeneous array items; references and conditional schemas are unsupported.");
    }
    if ((object(s.additionalProperties)) || Array.isArray(s.items)) throw new Error("Sensitive output requires explicit properties and homogeneous array items.");
    for (const key of ["$defs", "definitions"]) {
      if (object(s[key]) && Object.values(s[key]).some(hasSensitiveOutput)) throw new Error("Confidential definitions require reference resolution and cannot be disclosed.");
    }
    const classification = s["x-osf-classification"];
    if (classification !== undefined && (!object(classification) || classification.sensitivity !== "confidential" || Object.keys(classification).some(k => k !== "sensitivity"))) {
      throw new Error("Output x-osf-classification must declare sensitivity: confidential.");
    }
    if (privateNode(s) && !(s.type === "string" || (Array.isArray(s.type) && s.type.includes("string") && s.type.every(t => t === "string" || t === "null")))) {
      throw new Error("Confidential output fields must declare a string; classify each item for a collection of secrets.");
    }
    if (object(s.properties)) Object.values(s.properties).forEach(v => { if (object(v)) visit(v, depth + 1); });
    if (object(s.items)) visit(s.items, depth + 1);
  };
  visit(schema);
}

export type SensitiveOutputField = { path: string; label: string | Record<string, string>; value: unknown };

/** Only declared, non-confidential values enter model/audit projections. */
export function splitSensitiveOutput(schema: Schema, value: unknown): { publicValue: unknown; privateFields: SensitiveOutputField[] } {
  assertSensitiveOutputSchema(schema);
  const privateFields: SensitiveOutputField[] = [];
  const visit = (s: Schema, v: unknown, path: string): unknown => {
    if (privateNode(s)) {
      const i18n = s["x-osf-i18n"];
      const title = object(i18n) ? i18n.title : undefined;
      privateFields.push({ path, label: typeof title === "string" || object(title) ? title as SensitiveOutputField["label"] : path, value: v });
      return undefined;
    }
    if (Array.isArray(v)) return object(s.items) ? v.map((item, i) => visit(s.items as Schema, item, `${path}/${i}`)) : [];
    if (object(v)) return Object.fromEntries(Object.entries(object(s.properties) ? s.properties : {}).flatMap(([key, child]) => {
      if (!object(child) || !Object.hasOwn(v, key)) return [];
      const projected = visit(child, v[key], `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`);
      return projected === undefined ? [] : [[key, projected]];
    }));
    return v;
  };
  return { publicValue: visit(schema, value, ""), privateFields };
}
