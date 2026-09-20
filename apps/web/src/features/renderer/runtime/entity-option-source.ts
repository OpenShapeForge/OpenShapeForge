// SPDX-License-Identifier: BUSL-1.1
/**
 * Where a field's choices come from, read the way the compiler's web manifest
 * reads it (`fieldOptionSource` in `web-field-options.ts`): the field's own
 * `options` first, then its osf type's `options`, then the type's
 * `optionSource` — which is how a derived identity alias names its entity.
 * An entity source enumerates the entity's records through its list query;
 * a remote source fetches JSON from a declared endpoint. Nothing else is a
 * source: in particular a web route never is.
 */
import type { Field } from "@/generated/compiler/field-contract";
import { COMPILER_CORE_ENTITY_GRAPHQL_REGISTRY } from "@/generated/compiler/core-entity-graphql-registry";
import { COMPILER_OSF_TYPES } from "@/generated/compiler/osf-types";
import { getFieldOsfTypeDefinition } from "@/lib/field-rendering/compiler-field-rendering";

export type EntityOptionSource = {
  type: "entity";
  /** The entity's osfType name (PascalCase). */
  entity: string;
  /** The record field a value of the field holds; `id` for a reference. */
  valueField: string;
};

export type RemoteOptionSource = { type: "remote"; remoteUrl: string };

export type FieldOptionSource = EntityOptionSource | RemoteOptionSource;

type OptionsLike = { type?: string; source?: string; valueField?: string; remoteUrl?: string } | undefined;

function asSource(options: OptionsLike): FieldOptionSource | null {
  if (!options) return null;
  if (options.type === "entity" && options.source?.trim()) {
    return { type: "entity", entity: options.source.trim(), valueField: options.valueField?.trim() || "id" };
  }
  if (options.type === "remote" && options.remoteUrl?.trim()) {
    return { type: "remote", remoteUrl: options.remoteUrl.trim() };
  }
  return null;
}

export function resolveFieldOptionSource(field: Field | null | undefined): FieldOptionSource | null {
  if (!field) return null;
  const osfType = getFieldOsfTypeDefinition(field) as
    | { options?: OptionsLike; optionSource?: OptionsLike }
    | undefined;
  return asSource(field.options as OptionsLike) ?? asSource(osfType?.options) ?? asSource(osfType?.optionSource);
}

export function resolveEntityOptionSource(field: Field | null | undefined): EntityOptionSource | null {
  const source = resolveFieldOptionSource(field);
  return source?.type === "entity" ? source : null;
}

export function toKebabCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** What the web needs to list an entity's records and name each one. */
export function entityRecordListing(entity: string): {
  slug: string;
  plural: string;
  filterType: string;
  displayTemplate: string;
  filterField: string;
} | null {
  const slug = toKebabCase(entity);
  const registry = COMPILER_CORE_ENTITY_GRAPHQL_REGISTRY[slug as keyof typeof COMPILER_CORE_ENTITY_GRAPHQL_REGISTRY];
  if (!registry) return null;
  const aliasKey = `${entity.charAt(0).toLowerCase()}${entity.slice(1)}Id`;
  const alias = COMPILER_OSF_TYPES[aliasKey as keyof typeof COMPILER_OSF_TYPES] as
    | { displayTemplate?: string; filterField?: string }
    | undefined;
  return {
    slug,
    plural: registry.plural,
    filterType: registry.filterType,
    displayTemplate: alias?.displayTemplate ?? "{{id}}",
    filterField: alias?.filterField ?? "id",
  };
}
