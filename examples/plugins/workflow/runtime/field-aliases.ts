// SPDX-License-Identifier: BUSL-1.1
/**
 * Rewriting a stored config's aliased keys onto their canonical ones.
 *
 * A catalog field may declare `runtime.aliases`, so the same value can be
 * stored under more than one key — `decision`'s `branches` also answers to
 * `conditions`. Everything that reads a stored config has to agree about that
 * or it disagrees about the document: the validator once read only the
 * canonical key and therefore declared no handles for a node authored with the
 * alias, which left an unwired branch unreported and a correctly wired one
 * flagged.
 *
 * ## Why this is its own module
 *
 * It lives apart from `resolved-config-validation.ts`, which owns it
 * conceptually, because that module imports zod and the node catalog store —
 * and the store reads Postgres and throws when unhydrated. A browser bundle
 * that pulled it in for a ten-line key rewrite would ship a schema builder and
 * a database-backed singleton it can never use.
 *
 * So this file has NO imports at all. That is the point of it, and it is what
 * lets the designer share the one derivation rather than growing a second.
 */

type JsonRecord = Record<string, unknown>;

/**
 * The slice of a catalog field alias rewriting reads.
 *
 * Deliberately narrower than the runtime's own `RuntimeField`: this only ever
 * needs a key and its aliases, and reusing the full normalizer would drag its
 * cardinality, validation and shape handling along with it. Anything the full
 * normalizer would accept, this accepts identically for these two properties.
 */
export type FieldAliasSource = {
  key: string;
  aliases: string[];
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads `key` and `runtime.aliases` off an unvalidated catalog field array. */
export function readFieldAliasSources(configFields: unknown): FieldAliasSource[] {
  if (!Array.isArray(configFields)) return [];
  const sources: FieldAliasSource[] = [];
  for (const entry of configFields) {
    if (!isRecord(entry)) continue;
    const key = typeof entry.key === "string" ? entry.key.trim() : "";
    if (!key) continue;
    const runtime = isRecord(entry.runtime) ? entry.runtime : null;
    const aliases = Array.isArray(runtime?.aliases)
      ? runtime.aliases.filter((alias): alias is string => typeof alias === "string" && !!alias)
      : [];
    if (aliases.length > 0) sources.push({ key, aliases });
  }
  return sources;
}

/**
 * Copy each aliased value onto its canonical key.
 *
 * An explicit canonical key always wins, and is not overwritten even when an
 * alias is also present — a document that carries both is stating the canonical
 * one deliberately. Aliases are tried in declaration order, so a field naming
 * several has a defined precedence rather than an accidental one.
 *
 * Returns a new object; the input is never mutated.
 */
export function canonicalizeFieldAliases(
  config: JsonRecord,
  sources: readonly FieldAliasSource[],
): JsonRecord {
  if (sources.length === 0) return config;
  const next: JsonRecord = { ...config };
  for (const { key, aliases } of sources) {
    if (next[key] !== undefined) continue;
    for (const alias of aliases) {
      if (next[alias] !== undefined) {
        next[key] = next[alias];
        break;
      }
    }
  }
  return next;
}

/** The two steps together, for a caller holding a catalog entry's fields. */
export function canonicalizeConfigAliasesFromFields(
  config: unknown,
  configFields: unknown,
): JsonRecord {
  return canonicalizeFieldAliases(
    isRecord(config) ? config : {},
    readFieldAliasSources(configFields),
  );
}
