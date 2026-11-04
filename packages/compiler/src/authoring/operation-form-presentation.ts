// SPDX-License-Identifier: BUSL-1.1
import Ajv2020 from "ajv/dist/2020.js";

/** Presentation paths never remove inputs from the canonical Operation. */
export function operationForm(form: { showOnlyGroupedFields?: boolean; defaults?: Record<string, unknown>; groups: Array<{ title: { en?: string; nl?: string }; fields: string[]; collapsed?: boolean }> } | undefined, schema: Readonly<Record<string, unknown>>, origin: string, controlFields: readonly (string | undefined)[] = []) {
  if (!form) return undefined;
  if (form.groups.some(group => !group.title.en && !group.title.nl)) throw new Error(`${origin}: form group requires an English or Dutch title.`);
  const used: string[] = [];
  const groups = form.groups.map(group => ({ ...group, title: { en: group.title.en ?? group.title.nl ?? "", nl: group.title.nl ?? group.title.en ?? "" }, fields: group.fields.map(path => {
    if (used.some(previous => previous === path || previous.startsWith(`${path}.`) || path.startsWith(`${previous}.`))) throw new Error(`${origin}: overlapping form field ${path}.`);
    let node: unknown = schema;
    const parts = path.split(".");
    for (const [index, key] of parts.entries()) {
      const properties = node && typeof node === "object" && !Array.isArray(node) ? (node as { properties?: Record<string, unknown> }).properties : undefined;
      if (index > 0 && ((node as { oneOf?: unknown }).oneOf || (node as { anyOf?: unknown }).anyOf)) throw new Error(`${origin}: form field ${path} traverses a choice.`);
      if (index < parts.length - 1 && !(node as { required?: string[] }).required?.includes(key)) throw new Error(`${origin}: form field ${path} traverses an optional object.`);
      const required = (node as { required?: string[] }).required?.includes(key);
      node = properties?.[key];
      if (!node) throw new Error(`${origin}: unknown form field ${path}.`);
      if (group.collapsed && index === parts.length - 1 && required && !("default" in (node as object)) && !("const" in (node as object))) throw new Error(`${origin}: required form field ${path} cannot start collapsed.`);
    }
    used.push(path);
    return path;
  }) }));
  if (form.defaults) {
    const checkDefaults = (node: any, value: unknown, path: string) => {
      if (!node || !value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${origin}: invalid form defaults at ${path || "root"}.`);
      for (const [key, entry] of Object.entries(value)) {
        const child = node.properties?.[key];
        if (!child) throw new Error(`${origin}: unknown form default ${path}${key}.`);
        if (entry && typeof entry === "object" && !Array.isArray(entry) && child.properties) checkDefaults(child, entry, `${path}${key}.`);
        else {
          const ajv = new Ajv2020.default({ strict: false, validateFormats: false });
          if (!ajv.validate(child, entry)) throw new Error(`${origin}: invalid form default ${path}${key}.`);
        }
      }
    };
    checkDefaults(schema, form.defaults, "");
  }
  if (form.showOnlyGroupedFields) {
    const checkRequired = (node: any, defaults: any, path: string) => {
      for (const key of node.required ?? []) {
        if (!path && controlFields.includes(key)) continue;
        const field = node.properties?.[key];
        const current = path ? `${path}.${key}` : key;
        if (used.some(item => item === current || current.startsWith(`${item}.`))) continue;
        if (field?.const !== undefined || field?.default !== undefined) continue;
        if (field?.properties && (defaults?.[key] !== undefined || used.some(item => item.startsWith(`${current}.`)))) { checkRequired(field, defaults?.[key], current); continue; }
        if (defaults?.[key] !== undefined) continue;
        throw new Error(`${origin}: required form field ${current} is hidden without a default.`);
      }
      for (const [key, value] of Object.entries(defaults ?? {})) {
        if ((node.required ?? []).includes(key)) continue;
        const field = node.properties?.[key];
        if (field?.properties && value && typeof value === "object" && !Array.isArray(value)) checkRequired(field, value, path ? `${path}.${key}` : key);
      }
    };
    checkRequired(schema, form.defaults, "");
  }
  return { ...(form.showOnlyGroupedFields ? { showOnlyGroupedFields: true } : {}), ...(form.defaults ? { defaults: form.defaults } : {}), groups };
}

