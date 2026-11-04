// SPDX-License-Identifier: BUSL-1.1
/** Presentation paths never remove inputs from the canonical Operation. */
export function operationForm(form: { groups: Array<{ title: { en?: string; nl?: string }; fields: string[]; collapsed?: boolean }> } | undefined, schema: Readonly<Record<string, unknown>>, origin: string) {
  if (!form) return undefined;
  if (form.groups.some(group => !group.title.en && !group.title.nl)) throw new Error(`${origin}: form group requires an English or Dutch title.`);
  const used: string[] = [];
  const groups = form.groups.map(group => ({ ...group, title: { en: group.title.en ?? group.title.nl ?? "", nl: group.title.nl ?? group.title.en ?? "" }, fields: group.fields.map(path => {
    if (used.some(previous => previous === path || previous.startsWith(`${path}.`) || path.startsWith(`${previous}.`))) throw new Error(`${origin}: overlapping form field ${path}.`);
    let node: unknown = schema;
    const parts = path.split(".");
    for (const [index, key] of parts.entries()) {
      const unresolved = node && typeof node === "object" && !Array.isArray(node) ? (node as Record<string, unknown>)["x-osf-entityInput"] : undefined;
      if (unresolved && typeof unresolved === "object" && !Array.isArray(unresolved)) {
        const fields = (unresolved as { fields?: unknown }).fields;
        if (index !== parts.length - 1 || !Array.isArray(fields) || !fields.includes(key)) throw new Error(`${origin}: unknown form field ${path}.`);
        break; // The entity source is resolved and validated before final output.
      }
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
  return { groups };
}

