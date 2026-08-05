// SPDX-License-Identifier: BUSL-1.1
/**
 * What a node type's category IS, as opposed to what it says.
 *
 * `category` is a locale map since #260, like `label` and `description`, so the
 * palette heading can follow the reader. That solves the display half and opens
 * the other one: two things still need a category's *identity* rather than its
 * text — the palette groups on it, and `presentation.ts` colours a card by it —
 * and neither may vary with the request's locale. A group whose key changed
 * between an English and a Dutch read would be a different group on every
 * render, and a card would change colour with the language.
 *
 * So the identity is derived, in one place, by one rule:
 *
 * > the English spelling, trimmed and case-folded; absent an `en` key, the
 * > value under the alphabetically first locale present.
 *
 * **Case-folding stays**, and it is not tidiness. The set is open — a host
 * repo's pack introduces categories this repository has never seen — so
 * `Flow` and `flow` will meet again, and grouping on the raw string puts one
 * category in two buckets. That has already shipped here once. What the fold no
 * longer has to do is produce the heading: the heading is now authored text, so
 * `ai` no longer has to be reconstructed as `AI` by a map kept in step by hand.
 *
 * **English is the identity because something has to be**, and every locale map
 * in this repository carries `en`. The fallback exists so a pack that omits it
 * groups consistently rather than collapsing into one nameless bucket; it is
 * not an invitation to omit it. Renaming the English spelling of a category
 * regroups it, which is the honest consequence of an open set with no separate
 * key — see the note at the end of this file.
 */

/** The locale map the catalog serves for `category`. */
export type WorkflowNodeCategory = Record<string, string> | null | undefined;

/**
 * The group a node type belongs to. Locale-independent by construction.
 *
 * Returns null when there is no category at all — a catalog row that lost one,
 * since the authoring schema requires it. The caller decides what to do with
 * that; the palette buckets it rather than dropping the node, because a type
 * that exists and cannot be found is indistinguishable from one that does not.
 */
export function workflowNodeCategoryKey(category: WorkflowNodeCategory): string | null {
  const identity = englishSpelling(category);
  return identity === null ? null : identity.toLowerCase();
}

/**
 * One heading out of every category that resolved to the same key.
 *
 * Two packs can spell one category with different locale coverage — the
 * standard pack's `{ en: "Flow" }` beside a domain pack's
 * `{ en: "Flow", nl: "Stroom" }` — so the locales are unioned rather than one
 * row's map being picked whole. A Dutch reader gets the Dutch heading even
 * though the row that carries it is not the row that named the group.
 *
 * Ordered by `type` before merging, and first-wins per locale, so a genuine
 * disagreement resolves the same way on every read. The catalog is queried with
 * no `order by`, so "whichever arrived first" is not a fact about the data;
 * `type` is the table's primary key, and therefore is.
 */
export function mergeWorkflowNodeCategories(
  entries: ReadonlyArray<{ type: string; category: WorkflowNodeCategory }>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const entry of [...entries].sort((a, b) => a.type.localeCompare(b.type))) {
    if (!entry.category) continue;
    for (const [locale, value] of Object.entries(entry.category)) {
      const candidate = text(value);
      if (candidate !== null && merged[locale] === undefined) {
        merged[locale] = candidate;
      }
    }
  }
  return merged;
}

/**
 * The spelling the identity is taken from.
 *
 * Locales are sorted rather than taken in insertion order: object key order
 * follows however the row was serialized, which is not something a grouping key
 * should be able to see.
 */
function englishSpelling(category: WorkflowNodeCategory): string | null {
  if (!category) return null;
  const english = text(category.en);
  if (english !== null) return english;
  for (const locale of Object.keys(category).sort()) {
    const value = text(category[locale]);
    if (value !== null) return value;
  }
  return null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/*
 * Still open after this change, and deliberately not closed by it: nothing
 * validates a category against a list. The set is open on purpose — a host
 * repo's pack must be able to introduce one — so a typo in the English
 * spelling silently opens a group of one, exactly as it did when the field was
 * a bare string. Constraining the set is option 1 in #260 and a different
 * decision from this one.
 */
