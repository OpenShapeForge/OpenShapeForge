// SPDX-License-Identifier: BUSL-1.1
/**
 * The component catalog as the compiler uses it: the design system's field
 * components (generated from its Figma manifest into
 * `config/design-system/figma-fields.json`) joined with the authored
 * `catalogs/components.yaml`, which adds each field's non-Figma texts and
 * settings and the hand-written view, relationship, custom and extension
 * components.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ComponentCatalog, ComponentDefinition, FigmaFieldProp } from "./types.js";

export interface FigmaFieldsFile {
  fileKey: string | null;
  fields: Record<string, { figma: string; node: string; description: string; props: Record<string, FigmaFieldProp> }>;
  skipped: Array<{ figma: string; node: string; name: string; reason: string }>;
}

export const FIGMA_FIELDS_PATH = join(import.meta.dir, "..", "..", "config", "design-system", "figma-fields.json");

/** Figma's `state` is the field's run-time state; the renderer derives it, YAML never sets it. */
export const FIGMA_RUNTIME_PROPS = new Set(["state"]);

let figmaFieldsCache: FigmaFieldsFile | undefined;
export function figmaFields(): FigmaFieldsFile {
  return figmaFieldsCache ??= JSON.parse(readFileSync(FIGMA_FIELDS_PATH, "utf8")) as FigmaFieldsFile;
}

/**
 * The components the compiler gives a field itself: static options shown as
 * tiles and an entity identity's picker and display. Every catalog has them;
 * an authored catalog may describe them further.
 */
export const COMPILER_COMPONENTS: Readonly<Record<string, ComponentDefinition>> = {
  ChoiceTiles: { kind: "field", description: "Static options shown as tiles.", props: ["layout", "labelWidth"] },
  EntityReferenceSelect: { kind: "field", description: "Picks a record of the referenced entity.", props: ["layout", "labelWidth"] },
  EntityReferenceDisplay: { kind: "field", description: "Shows the referenced record.", props: ["layout", "labelWidth"] },
};

/**
 * Folds the design system's fields into an authored catalog. The authored
 * `fields` may only describe a field Figma has, and a hand-written component
 * may not take a Figma field's name.
 */
export function composeComponentCatalog(authored: ComponentCatalog, figma: FigmaFieldsFile = figmaFields()): ComponentCatalog {
  const { fieldTexts = [], fields = {}, components = {}, ...rest } = authored;
  for (const name of Object.keys(fields)) {
    if (!figma.fields[name]) throw new Error(`catalogs/components.yaml: fields.${name} is no design-system field; Figma's fields are ${Object.keys(figma.fields).join(", ")}.`);
  }
  const composed: Record<string, ComponentDefinition> = { ...COMPILER_COMPONENTS };
  for (const [name, field] of Object.entries(figma.fields)) {
    const own = fields[name] ?? {};
    composed[name] = {
      kind: "field",
      description: field.description,
      props: [...Object.keys(field.props).filter((prop) => !FIGMA_RUNTIME_PROPS.has(prop)), ...(own.props ?? [])],
      texts: [...fieldTexts, ...(own.texts ?? [])],
      figma: { name: field.figma, node: field.node, props: field.props },
    };
  }
  for (const [name, component] of Object.entries(components)) {
    if (figma.fields[name]) throw new Error(`catalogs/components.yaml: ${name} is a design-system field; describe its texts and settings under fields.${name}.`);
    composed[name] = component;
  }
  return { ...rest, components: composed } as ComponentCatalog;
}

/** Reads `catalogs/components.yaml` of an authoring directory and folds the design system's fields in. */
export function loadComponentCatalog(authoringDir: string): ComponentCatalog {
  const path = join(authoringDir, "catalogs", "components.yaml");
  return composeComponentCatalog(parseYaml(readFileSync(path, "utf8")) as ComponentCatalog);
}
