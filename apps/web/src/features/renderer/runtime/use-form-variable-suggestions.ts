// SPDX-License-Identifier: BUSL-1.1
/**
 * WEB-020 — Form-level variable suggestions hook.
 *
 * Resolves each {@link FormVariableSource} declared on the form to a
 * `VariableSuggestion[]` and returns them as a map keyed by source.key, so
 * fields can look up their pre-resolved pool from `FieldRenderContext`.
 *
 * Handles sync and async resolvers uniformly via `Promise.resolve` on the
 * return value. Async sources surface silent-empty while loading (design
 * decision 2 from Hans). Stale entries are cleared immediately when their
 * dependencies change (decision 3).
 *
 * Design doc section 4.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { VARIABLE_SOURCE_REGISTRY } from "@/features/renderer/runtime/variable-source-registry";
import type {
  FormVariableSource,
  ResolverContext,
} from "@/features/renderer/runtime/variable-sources";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";

function buildSourcesSnapshot(
  sources: readonly FormVariableSource[] | undefined,
): string {
  if (!sources || sources.length === 0) return "[]";
  return JSON.stringify(
    sources.map((s) => ({ key: s.key, resolver: s.resolver, params: s.params ?? null })),
  );
}

function buildResolutionSnapshot(
  sources: readonly FormVariableSource[] | undefined,
  formState: Record<string, unknown>,
  lang: string,
): string {
  if (!sources || sources.length === 0) return "[]";
  const ctx: ResolverContext = { formState, lang };
  return JSON.stringify(
    sources.map((source) => {
      const resolver = VARIABLE_SOURCE_REGISTRY[source.resolver];
      const dependencyKey = resolver?.getDependencyKey
        ? resolver.getDependencyKey(source.params, ctx)
        : JSON.stringify({ formState, lang });
      return {
        key: source.key,
        resolver: source.resolver,
        dependencyKey,
      };
    }),
  );
}

export function useFormVariableSuggestions(
  variableSources: readonly FormVariableSource[] | undefined,
  formState: Record<string, unknown>,
  lang: string,
): Record<string, VariableSuggestion[]> {
  const [resolved, setResolved] = useState<Record<string, VariableSuggestion[]>>(
    {},
  );

  const sourcesSnapshot = useMemo(
    () => buildSourcesSnapshot(variableSources),
    [variableSources],
  );
  const resolutionSnapshot = useMemo(
    () => buildResolutionSnapshot(variableSources, formState, lang),
    [formState, lang, variableSources],
  );

  // Track the current request generation per source so late-returning async
  // resolvers can no-op if the user has already changed the inputs.
  const generationRef = useRef<Record<string, number>>({});
  const dependencyRef = useRef<Record<string, string>>({});
  useEffect(() => {
    const sources = variableSources ?? [];
    const currentKeys = sources.map((s) => s.key);
    const currentKeySet = new Set(currentKeys);

    // Prune keys that are no longer declared.
    setResolved((prev) => {
      let changed = false;
      const next: Record<string, VariableSuggestion[]> = {};
      for (const k of currentKeys) {
        if (prev[k] !== undefined) {
          next[k] = prev[k]!;
        }
      }
      for (const key of Object.keys(prev)) {
        if (!currentKeySet.has(key)) {
          changed = true;
          break;
        }
      }
      return changed ? next : prev;
    });
    for (const key of Object.keys(dependencyRef.current)) {
      if (!currentKeySet.has(key)) {
        delete dependencyRef.current[key];
        delete generationRef.current[key];
      }
    }
    const ctx: ResolverContext = { formState, lang };

    for (const source of sources) {
      const resolver = VARIABLE_SOURCE_REGISTRY[source.resolver];
      if (!resolver) {
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.warn(
            `[useFormVariableSuggestions] No resolver registered for "${source.resolver}" (source key "${source.key}").`,
          );
        }
        continue;
      }

      const dependencyKey = resolver.getDependencyKey
        ? resolver.getDependencyKey(source.params, ctx)
        : JSON.stringify({ formState, lang });
      const sourceDependency = JSON.stringify({
        resolver: source.resolver,
        dependencyKey,
      });
      if (dependencyRef.current[source.key] === sourceDependency) {
        continue;
      }
      dependencyRef.current[source.key] = sourceDependency;

      const generation = (generationRef.current[source.key] ?? 0) + 1;
      generationRef.current[source.key] = generation;
      const sourceKey = source.key;

      // Clear only the source whose own dependency changed. Other sources,
      // including global chips, must remain stable while the user edits fields
      // they do not depend on.
      setResolved((prev) => {
        if (!(sourceKey in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[sourceKey];
        return next;
      });

      let result: VariableSuggestion[] | Promise<VariableSuggestion[]>;
      try {
        result = resolver.resolve(source.params, ctx);
      } catch (err) {
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.warn(
            `[useFormVariableSuggestions] Resolver "${source.resolver}" threw synchronously for source "${sourceKey}":`,
            err,
          );
        }
        continue;
      }

      Promise.resolve(result)
        .then((suggestions) => {
          // If a newer resolve was started for this source key, drop this result.
          if (generationRef.current[sourceKey] !== generation) {
            return;
          }
          setResolved((prev) => ({ ...prev, [sourceKey]: suggestions }));
        })
        .catch((err) => {
          if (process.env.NODE_ENV !== "production") {
            // eslint-disable-next-line no-console
            console.warn(
              `[useFormVariableSuggestions] Resolver "${source.resolver}" rejected for source "${sourceKey}":`,
              err,
            );
          }
        });
    }
    // We intentionally rely on the stable JSON snapshots below; variableSources
    // and formState are fresh closure captures used inside the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesSnapshot, resolutionSnapshot, lang]);

  return resolved;
}
