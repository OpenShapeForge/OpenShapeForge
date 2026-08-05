// SPDX-License-Identifier: BUSL-1.1
/**
 * What a palette may offer, and what it must refuse.
 *
 * The node catalog describes every node type this deployment knows about. Far
 * fewer of them run. `runtimeSupport` is the field that says which — see
 * `runtime/node-executability.ts` — and this module is the palette's half of
 * that contract:
 *
 * - **`EXECUTABLE`** is offered.
 * - **`UNIMPLEMENTED`** is shown, disabled. The type is real and a host repo
 *   can supply a bridge for it, so hiding it would misdescribe the catalog;
 *   offering it would let a user draw a graph that publishes and then dies on
 *   NO_BRIDGE at the first run.
 * - **`UNSUPPORTED`** is not shown at all. `join` and `split` describe fan-out
 *   and the process runtime holds a single cursor (#236), so no bridge would
 *   help. A disabled entry says "not yet"; there is no "yet".
 *
 * Executability is the gate. `catalog` — which pack authored a type — is
 * provenance, and answers a different question: filtering on it would still
 * offer seven unbridged standard types, and would hide every domain node from
 * the one deployment that implemented one. It is carried through as a label
 * and decides nothing.
 *
 * Pure, like everything else in `web/`: `apps/web` has no test runner, so the
 * rules live where `bun test examples` can reach them and the component that
 * draws them stays assembly.
 */
import {
  mergeWorkflowNodeCategories,
  workflowNodeCategoryKey,
  type WorkflowNodeCategory,
} from "../node-category";

/** The slice of a catalog entry a palette reads. */
export type WorkflowPaletteNodeType = {
  type: string;
  /**
   * Localized, like the label — the catalog serves a locale map and the
   * compiler is the only place that ever sees a bare string (#260).
   */
  category?: Record<string, string> | null;
  /** Localized; the caller picks a locale. */
  label?: Record<string, string> | null;
  description?: Record<string, string> | null;
  /** `EXECUTABLE` / `UNIMPLEMENTED` / `UNSUPPORTED`, in either case. */
  runtimeSupport?: string | null;
  catalog?: string | null;
};

/** Why an offered node type cannot be placed. Null when it can. */
export type WorkflowPaletteUnavailability = "UNIMPLEMENTED";

export type WorkflowPaletteItem = {
  type: string;
  label: string;
  description: string | null;
  /** Which pack authored it. A label for the reader, never a gate. */
  catalog: string | null;
  unavailable: WorkflowPaletteUnavailability | null;
};

export type WorkflowPaletteGroup = {
  /**
   * The category's identity: its English spelling, case-folded. Stable across
   * spellings and across locales, and the React key. `web/node-category.ts`
   * derives it and says why it is not the heading.
   */
  key: string;
  /** The heading, in the reader's locale. Authored, not reconstructed. */
  label: string;
  items: WorkflowPaletteItem[];
};

export type BuildWorkflowPaletteInput = {
  nodeTypes: ReadonlyArray<WorkflowPaletteNodeType>;
  /** Preferred locale for labels; falls back to English, then to any. */
  locale?: string;
};

/**
 * Node types with no category, and the group they land in.
 *
 * `category` is required by the authoring schema, so this is for a catalog row
 * that lost one some other way. Bucketing them is better than dropping them:
 * a type that exists and cannot be found is indistinguishable from one that
 * does not exist.
 */
const UNCATEGORIZED_KEY = "other";

/**
 * The group triggers land in, hoisted to the top.
 *
 * Not a general priority list — one entry, for one reason: a workflow cannot
 * start without a trigger, so the group that holds them is the one a reader
 * needs first. Everything else sorts alphabetically.
 *
 * Matched against the key, which is the English spelling case-folded, so this
 * does not have to be restated per locale — a Dutch reader's `Triggers` group
 * is hoisted by the same line.
 */
const FIRST_GROUP_KEY = "triggers";

/** A group under construction: its members, and every spelling of its name. */
type PaletteGroupDraft = {
  items: WorkflowPaletteItem[];
  categories: Array<{ type: string; category: WorkflowNodeCategory }>;
};

export function buildWorkflowPalette(
  input: BuildWorkflowPaletteInput,
): WorkflowPaletteGroup[] {
  const locale = input.locale ?? "en";
  const byKey = new Map<string, PaletteGroupDraft>();

  for (const entry of input.nodeTypes) {
    const type = asString(entry?.type);
    if (!type) continue;

    const support = normalizeRuntimeSupport(entry.runtimeSupport);
    // Unknown states are refused rather than offered. A support value this
    // module has not been taught is one it cannot promise anything about, and
    // the honest failure is an absent entry rather than a placed node that
    // dies on its first run.
    if (support !== "EXECUTABLE" && support !== "UNIMPLEMENTED") continue;

    const key = workflowNodeCategoryKey(entry.category) ?? UNCATEGORIZED_KEY;
    const draft = byKey.get(key) ?? { items: [], categories: [] };
    draft.items.push({
      type,
      label: localized(entry.label, locale) ?? type,
      description: localized(entry.description, locale),
      catalog: asString(entry.catalog),
      unavailable: support === "UNIMPLEMENTED" ? "UNIMPLEMENTED" : null,
    });
    draft.categories.push({ type, category: entry.category });
    byKey.set(key, draft);
  }

  const groups: WorkflowPaletteGroup[] = [];
  for (const [key, draft] of byKey) {
    groups.push({
      key,
      label: groupLabel(key, draft, locale),
      items: draft.items.sort(compareItems),
    });
  }
  return groups.sort(compareGroups);
}

/**
 * What the group is shown as: the category, in the reader's locale.
 *
 * Authored now rather than reconstructed. The heading used to be the grouping
 * key with its first letter capitalised, plus a hand-kept map that turned `ai`
 * back into `AI` — a second description of a category, and untranslatable, both
 * because `category` was one bare word (#260). It is a locale map now, so the
 * heading is text somebody wrote in the language it is read in.
 *
 * The fallback is that same capitalised key, for the group that has no heading
 * to show: a catalog row whose `category` went missing, or one carrying only
 * locales this reader does not have. `Other` is what an absent category folds
 * to and reads correctly; an acronym does not, which is the honest limit of
 * capitalising a fold and the reason it is a fallback rather than the rule.
 */
function groupLabel(
  key: string,
  draft: PaletteGroupDraft,
  locale: string,
): string {
  const merged = mergeWorkflowNodeCategories(draft.categories);
  return localized(merged, locale) ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * Available first, then alphabetically.
 *
 * A category can hold more unavailable types than available ones — the domain
 * packs ship node types this deployment has no bridge for — and a reader
 * scanning for something to place should not have to read past them. Within
 * each half the order is the label's, so it does not move when a bridge is
 * registered somewhere else in the catalog.
 */
function compareItems(left: WorkflowPaletteItem, right: WorkflowPaletteItem): number {
  if ((left.unavailable === null) !== (right.unavailable === null)) {
    return left.unavailable === null ? -1 : 1;
  }
  return left.label.localeCompare(right.label) || left.type.localeCompare(right.type);
}

/**
 * Triggers first, then the reader's own alphabet.
 *
 * Ordered by the heading rather than by the key, so the list reads as sorted in
 * the language it is shown in — `Stroom` after `Integraties` in Dutch where
 * `Flow` comes before `Integrations` in English. The hoist is the one part that
 * cannot move with the locale, which is why it matches on the key.
 */
function compareGroups(left: WorkflowPaletteGroup, right: WorkflowPaletteGroup): number {
  if (left.key !== right.key) {
    if (left.key === FIRST_GROUP_KEY) return -1;
    if (right.key === FIRST_GROUP_KEY) return 1;
  }
  return left.label.localeCompare(right.label);
}

/** The wire spells the enum SCREAMING_CASE; the runtime union is lower case. */
function normalizeRuntimeSupport(value: unknown): string | null {
  const text = asString(value);
  return text === null ? null : text.toUpperCase();
}

/** The same locale fallback `presentation.ts` applies to a node type's label. */
function localized(
  map: Record<string, string> | null | undefined,
  locale: string,
): string | null {
  if (!map) return null;
  return (
    asString(map[locale]) ??
    asString(map.en) ??
    Object.values(map).map(asString).find((value) => value !== null) ??
    null
  );
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
