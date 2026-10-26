// SPDX-License-Identifier: BUSL-1.1
/**
 * The compiler's own JSON schema for an entity's authorable `interfaces.web`,
 * resolved into one standalone document for the product app's design mode.
 *
 * The source is `core-entity.schema.json`'s `entityInterfacesV2.properties.web`
 * (with its `$defs`, and the `render` definition it borrows from
 * `field-definition.schema.json`). Two things are done to it here, both
 * because the consumer is a form renderer that walks the schema eagerly:
 *
 * - every `$ref` is inlined, and the one recursion in the contract (a view
 *   group's `groups` are view groups) is unrolled to `GROUP_DEPTH` levels below
 *   a tab — deeper nesting exists in no authored entity and the compiled
 *   manifest flattens it anyway;
 * - the definition a node came from is kept as `x-osf-def`, and the contract's
 *   own `x-osf-choice` markers (what a node chooses from: field, relationship,
 *   operation, component, renderer — OSF #646) survive inlining, so the app
 *   fills choices from the markers without knowing the schema's shape. A
 *   property the contract gains later arrives here by itself.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const GROUP_DEPTH = 2;
type Json = Record<string, unknown>;

function schemasDir(): string {
  return join(join(import.meta.dir,"../.."), "config", "schemas");
}

export function resolvedWebInterfaceSchema(): Json {
  const core = JSON.parse(readFileSync(join(schemasDir(), "core-entity.schema.json"), "utf8")) as Json;
  const fieldDefinition = JSON.parse(readFileSync(join(schemasDir(), "field-definition.schema.json"), "utf8")) as Json;
  const defs = core.$defs as Record<string, Json>;
  const fieldDefs = fieldDefinition.$defs as Record<string, Json>;

  const pointer = (root: Json, path: string): Json | undefined => {
    let node: unknown = root;
    for (const token of path.split("/")) {
      if (!node || typeof node !== "object") return undefined;
      node = (node as Json)[token.replace(/~1/g, "/").replace(/~0/g, "~")];
    }
    return node && typeof node === "object" ? node as Json : undefined;
  };

  const lookup = (ref: string): { name: string; node: Json } => {
    const local = ref.match(/^#\/\$defs\/(.+)$/);
    if (local) return { name: local[1]!, node: pointer(defs, local[1]!) ?? fail(ref) };
    const external = ref.match(/field-definition\.schema\.json#\/\$defs\/(.+)$/);
    if (external) return { name: `fieldDefinition.${external[1]}`, node: pointer(fieldDefs, external[1]!) ?? fail(ref) };
    return fail(ref);
  };

  // `depth` counts view-group levels entered; a group's `groups` beyond the
  // budget is dropped rather than left dangling.
  const resolve = (node: unknown, depth: number): unknown => {
    if (Array.isArray(node)) return node.map((item) => resolve(item, depth));
    if (!node || typeof node !== "object") return node;
    const schema = node as Json;
    if (typeof schema.$ref === "string") {
      const { name, node: target } = lookup(schema.$ref);
      if (name === "webViewGroupV2") {
        if (depth >= GROUP_DEPTH) return undefined;
        const group = resolve(target, depth + 1) as Json;
        return { ...group, "x-osf-def": name };
      }
      const rest = { ...schema };
      delete rest.$ref;
      return { ...(resolve(target, depth) as Json), ...(resolve(rest, depth) as Json), "x-osf-def": name };
    }
    const out: Json = {};
    for (const [key, value] of Object.entries(schema)) {
      const resolved = resolve(value, depth);
      if (resolved !== undefined) out[key] = resolved;
    }
    // An array whose items hit the recursion budget goes with them.
    if (out.type === "array" && "items" in schema && !("items" in out)) return undefined;
    // A property that resolved to nothing (the recursion budget) must not be
    // referenced by what is left: drop it from `required`, and drop every
    // anyOf/oneOf/allOf branch that requires it; a combinator with no branch
    // left goes entirely.
    if (out.properties && typeof out.properties === "object") {
      const present = (key: string) => key in (out.properties as Json);
      if (Array.isArray(out.required)) {
        out.required = (out.required as string[]).filter(present);
        if ((out.required as string[]).length === 0) delete out.required;
      }
      for (const combinator of ["anyOf", "oneOf", "allOf"]) {
        if (!Array.isArray(out[combinator])) continue;
        const kept = (out[combinator] as Json[]).filter((branch) => !Array.isArray(branch.required) || (branch.required as string[]).every(present));
        if (kept.length) out[combinator] = kept; else delete out[combinator];
      }
    }
    return out;
  };

  const web = (defs.entityInterfacesV2!.properties as Json).web as Json;
  return resolve(web, 0) as Json;
}

function fail(ref: string): never {
  throw new Error(`core-entity.schema.json: cannot resolve ${ref} for the web interface schema.`);
}
