// SPDX-License-Identifier: BUSL-1.1
/**
 * The stored shape of a field binding, shared by the compiler that generates
 * the column and the runtime that resolves it.
 *
 * A record keeps its bindings in ONE generated JSONB map per bindable entity,
 * beside the ordinary value columns — not a column per field, and not a
 * second entity. The map holds what the author asked for; each value column
 * holds what that binding resolved to at the last write. The two are
 * deliberately separate: the binding is the intent and survives, the value is
 * a result and is revalidated against its source on every live read.
 *
 * A binding is never discovered by scanning a value for `{{…}}`. It is
 * supplied as its own input and stored as its own structure, so token-like
 * text in an ordinary field stays literal text — including in a field whose
 * tokens another engine interprets.
 */

import type { FieldVariableMode } from "./field-variables.js";

/** The one server-owned column that carries a record's bindings. */
export const FIELD_BINDINGS_COLUMN = "field_bindings";

/** The authored field name that column projects as on every transport. */
export const FIELD_BINDINGS_FIELD = "fieldBindings";

/**
 * One stored binding: a whole-value reference, or the authored template whose
 * tokens are filled. A template keeps its source text because that text IS
 * the binding — re-resolving it is what makes a later source change visible.
 */
export type FieldBinding =
  | { readonly kind: "whole"; readonly ref: string }
  | { readonly kind: "template"; readonly source: string };

/** A record's bindings, by authored field key. */
export type FieldBindingMap = Readonly<Record<string, FieldBinding>>;

/** The longest authored template a binding may carry; the column is unbounded, the contract is not. */
export const MAX_BINDING_TEMPLATE_LENGTH = 20_000;

export function isFieldBinding(value: unknown): value is FieldBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  if (binding.kind === "whole") {
    return typeof binding.ref === "string" && Object.keys(binding).length === 2;
  }
  if (binding.kind === "template") {
    return typeof binding.source === "string" &&
      binding.source.length <= MAX_BINDING_TEMPLATE_LENGTH &&
      Object.keys(binding).length === 2;
  }
  return false;
}

/** A stored map, or `undefined` when the column holds anything else. */
export function fieldBindingMap(value: unknown): FieldBindingMap | undefined {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([, binding]) => isFieldBinding(binding))) return undefined;
  return Object.fromEntries(entries) as FieldBindingMap;
}

/** Whether the mode a field authored admits a binding of this kind. */
export function bindingKindPermitted(mode: FieldVariableMode, binding: FieldBinding): boolean {
  return mode === "both" || mode === binding.kind;
}
