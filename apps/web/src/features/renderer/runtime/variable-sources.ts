// SPDX-License-Identifier: BUSL-1.1
/**
 * WEB-020 — Form-level variable sources.
 *
 * A form declares an array of `FormVariableSource` entries; the renderer resolves
 * each to a `VariableSuggestion[]` once per form and threads the result through
 * the `FieldRenderContext`. Fields opt in by sourceKey (Phase 4b onwards).
 *
 * Design doc: docs/architecture/form-variable-sources.md sections 2-4.
 */
import type { VariableFilter } from "@/features/renderer/runtime/variable-compatibility";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";

/**
 * Identifier for a built-in resolver registered in `variable-source-registry.ts`.
 *
 * Kept as a string union so each call site gets autocomplete; new resolvers are
 * added to both the registry and this union in one commit.
 */
export type VariableSourceResolverId =
  | "chips"
  | "entityFields"
  | "templateParameters"
  | "workflowGraphVariables";

/**
 * A named, parameterised reference to a resolver. Forms declare these; the
 * resolver registry handles the resolution.
 */
export type FormVariableSource = {
  /** Stable key used by fields to opt in (e.g. "entityFields", "bodyTemplateParams"). */
  key: string;
  /** Resolver id registered in {@link VARIABLE_SOURCE_REGISTRY}. */
  resolver: VariableSourceResolverId;
  /**
   * Resolver-specific params. Typed loosely here; each resolver narrows its
   * own input via {@link ResolverContext}.
   */
  params?: Record<string, unknown>;
};

/**
 * The shape a `Field.suggestions` entry will take once the compiler emits it
 * (Phase 4b). Not yet read from the generated `FieldSuggestions` type — the
 * consumer casts through a narrowing helper until the compiler catches up.
 *
 * Design doc section 2.2.
 */
export type FieldSuggestionsOptIn = {
  /** Key of a {@link FormVariableSource} declared on the enclosing form. */
  sourceKey: string;
  /**
   * Optional static filter applied on top of the source's full list.
   * When absent, the renderer infers a filter via `getVariableFilterForField`.
   */
  filter?: VariableFilter;
};

/**
 * Context passed to every resolver. Stateless by contract; the hook holds
 * cache state, not the resolvers.
 */
export type ResolverContext = {
  /** Current flat form state keyed by field key. */
  formState: Record<string, unknown>;
  /** Active UI language. */
  lang: string;
};

export type VariableSuggestionResolver = {
  id: VariableSourceResolverId;
  /**
   * Stable dependency key for this resolver. The hook re-resolves a source only
   * when this key changes. Resolvers that read no form state should return a
   * key derived from params only, so unrelated keystrokes do not clear and
   * repopulate their suggestion pools.
   */
  getDependencyKey?: (
    params: Record<string, unknown> | undefined,
    ctx: ResolverContext,
  ) => string;
  resolve(
    params: Record<string, unknown> | undefined,
    ctx: ResolverContext,
  ): VariableSuggestion[] | Promise<VariableSuggestion[]>;
};
