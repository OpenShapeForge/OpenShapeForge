// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";
import { getCompilerSemanticTypeDefinition } from "@/lib/field-rendering/compiler-field-rendering";

type Lang = "nl" | "en";

export type SemanticCollectionMeta = {
  itemPreview?: { template: string };
  derivedFields?: Record<string, { from: string; format?: "slug" }>;
  uniqueBy?: string;
};

/**
 * These three keys are optional collection affordances a semantic-type catalog
 * may declare. The compiled `SemanticTypeDefinition` in this repo does not
 * model them, so they are read structurally rather than off the generated type:
 * a catalog that declares them is honoured, and one that does not yields `{}`,
 * which every consumer below already treats as "no collection metadata".
 */
export function resolveSemanticCollectionMeta(
  field: Pick<Field, "semanticType">,
): SemanticCollectionMeta {
  const def = field.semanticType
    ? getCompilerSemanticTypeDefinition(field.semanticType)
    : undefined;
  if (!isRecord(def)) return {};

  const itemPreview = def.itemPreview;
  const derivedFields = def.derivedFields;
  const uniqueBy = def.uniqueBy;

  return {
    ...(isRecord(itemPreview) && typeof itemPreview.template === "string"
      ? { itemPreview: { template: itemPreview.template } }
      : {}),
    ...(isRecord(derivedFields)
      ? {
          derivedFields: derivedFields as Record<
            string,
            { from: string; format?: "slug" }
          >,
        }
      : {}),
    ...(typeof uniqueBy === "string" ? { uniqueBy } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function localizedTextValue(value: unknown, lang: Lang): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "";
  const selected = value[lang] ?? value.nl ?? value.en;
  return typeof selected === "string" ? selected : "";
}

export function slugify(seed: unknown): string {
  const text = typeof seed === "string" ? seed : "";
  const slug = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.replace(/^[^a-z]+/, "");
}

function readItemText(
  item: Record<string, unknown>,
  key: string,
  lang: Lang,
): string {
  return localizedTextValue(item[key], lang);
}

export function interpolatePreview(
  template: string,
  item: unknown,
  lang: Lang,
): string {
  const record = isRecord(item) ? item : {};
  return template.replace(
    /\{\{\s*([\w.-]+)\s*\}\}/g,
    (_match, rawKey: string) => {
      const key = rawKey.trim();
      const text = readItemText(record, key, lang).trim();
      return text || key;
    },
  );
}

function deriveValue(
  item: Record<string, unknown>,
  spec: { from: string; format?: "slug" },
  lang: Lang,
): string {
  const seed = readItemText(item, spec.from, lang);
  return spec.format === "slug" ? slugify(seed) : seed;
}

export function normalizeCollectionRows(
  nextItems: unknown[],
  previousItems: unknown[],
  meta: SemanticCollectionMeta,
  lang: Lang,
): unknown[] {
  const derivedFields = meta.derivedFields ?? {};
  const uniqueKey = meta.uniqueBy;
  const used = new Set<string>();

  return nextItems.map((item, index) => {
    if (!isRecord(item)) return item;
    const previous = isRecord(previousItems[index]) ? previousItems[index] : {};
    const next: Record<string, unknown> = { ...item };

    for (const [targetKey, spec] of Object.entries(derivedFields)) {
      const explicit =
        typeof next[targetKey] === "string"
          ? (next[targetKey] as string).trim()
          : "";
      const previousValue =
        typeof previous[targetKey] === "string"
          ? (previous[targetKey] as string).trim()
          : "";
      const derived = explicit || previousValue || deriveValue(next, spec, lang);
      next[targetKey] = derived || targetKey;
    }

    if (uniqueKey) {
      const base =
        typeof next[uniqueKey] === "string"
          ? (next[uniqueKey] as string).trim()
          : "";
      const explicitOriginal =
        typeof item[uniqueKey] === "string"
          ? (item[uniqueKey] as string).trim()
          : "";
      let candidate = base || uniqueKey;
      if (!explicitOriginal) {
        let suffix = 2;
        while (used.has(candidate)) {
          candidate = `${base || uniqueKey}-${suffix}`;
          suffix += 1;
        }
      }
      used.add(candidate);
      next[uniqueKey] = candidate;
    }

    return next;
  });
}
