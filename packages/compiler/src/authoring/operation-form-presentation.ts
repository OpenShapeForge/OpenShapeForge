// SPDX-License-Identifier: BUSL-1.1
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

/** Presentation paths never remove inputs from the canonical Operation. */
export function operationForm(form: { showOnlyGroupedFields?: boolean; defaults?: Record<string, unknown>; groups: Array<{ title: { en?: string; nl?: string }; fields: string[]; collapsed?: boolean }> } | undefined, schema: Readonly<Record<string, unknown>>, origin: string, controlFields: readonly (string | undefined)[] = []) {
  if (!form) return undefined;
  if (form.defaults && !form.showOnlyGroupedFields) throw new Error(`${origin}: form defaults require showOnlyGroupedFields.`);
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
    // Preserve the root and its $defs/cross-field rules; only relax fields the
    // person will fill later. Keep required inside `not` and conditionals.
    const supplied = (path: readonly string[]) => {
      let value: unknown = form.defaults;
      for (const key of path) {
        if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, key)) return false;
        value = (value as Record<string, unknown>)[key];
      }
      return true;
    };
    const relax = (value: unknown, path: readonly string[] = [], preserve = false): unknown => {
      if (Array.isArray(value)) return value.map(item => relax(item, path, preserve));
      if (!value || typeof value !== "object") return value;
      const full = preserve || (path.length > 0 && supplied(path) && !used.some(field => field.startsWith(`${path.join(".")}.`) || field === path.join(".")));
      return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
        if (key === "required" && !full) return [];
        if (key === "properties" && entry && typeof entry === "object" && !Array.isArray(entry)) {
          return [[key, Object.fromEntries(Object.entries(entry).map(([name, child]) => [name, relax(child, [...path, name], full)]))]];
        }
        return [[key, relax(entry, path, full || key === "not" || key === "if" || key === "then" || key === "else" || key === "$defs")]];
      }));
    };
    const sample = (value: unknown, locale: string): unknown => {
      if (Array.isArray(value)) return value.map(entry => sample(entry, locale));
      if (!value || typeof value !== "object") return value;
      const object = value as Record<string, unknown>;
      if (Object.keys(object).length === 1 && object.from === "uiLocale") return locale;
      return Object.fromEntries(Object.entries(object).map(([key, entry]) => [key, sample(entry, locale)]));
    };
    for (const key of Object.keys(form.defaults)) if (!(key in (schema.properties as Record<string, unknown> ?? {}))) throw new Error(`${origin}: invalid form defaults.`);
    const ajv = new Ajv2020.default({ strict: false });
    addFormats.default(ajv);
    for (const locale of ["en", "nl"]) if (!ajv.validate(relax(schema) as object, sample(form.defaults, locale))) throw new Error(`${origin}: invalid form defaults: ${ajv.errorsText(ajv.errors)}.`);
  }
  if (form.showOnlyGroupedFields) {
    if (groups.some(group => group.collapsed)) throw new Error(`${origin}: compact form groups cannot be collapsed.`);
    const checkRequired = (node: any, defaults: any, path: string) => {
      if (node.allOf || node.oneOf || node.anyOf || node.if || node.then || node.else) throw new Error(`${origin}: hidden form fields cannot use conditional or composed requirements at ${path || "root"}.`);
      for (const key of node.required ?? []) {
        if (!path && controlFields.includes(key)) continue;
        const field = node.properties?.[key];
        const current = path ? `${path}.${key}` : key;
        if (used.some(item => item === current || current.startsWith(`${item}.`))) continue;
        if (field?.const !== undefined) continue;
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

