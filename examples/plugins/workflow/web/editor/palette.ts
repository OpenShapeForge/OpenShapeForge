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

/** The slice of a catalog entry a palette reads. */
export type WorkflowPaletteNodeType = {
  type: string;
  category?: string | null;
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
  /** The case-folded category. Stable across spellings, and the React key. */
  key: string;
  /** What to show for the group. Derived from {@link key}, see below. */
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
 */
const FIRST_GROUP_KEY = "triggers";

export function buildWorkflowPalette(
  input: BuildWorkflowPaletteInput,
): WorkflowPaletteGroup[] {
  const locale = input.locale ?? "en";
  const byKey = new Map<string, WorkflowPaletteItem[]>();

  for (const entry of input.nodeTypes) {
    const type = asString(entry?.type);
    if (!type) continue;

    const support = normalizeRuntimeSupport(entry.runtimeSupport);
    // Unknown states are refused rather than offered. A support value this
    // module has not been taught is one it cannot promise anything about, and
    // the honest failure is an absent entry rather than a placed node that
    // dies on its first run.
    if (support !== "EXECUTABLE" && support !== "UNIMPLEMENTED") continue;

    const key = categoryKey(entry.category);
    const items = byKey.get(key) ?? [];
    items.push({
      type,
      label: localized(entry.label, locale) ?? type,
      description: localized(entry.description, locale),
      catalog: asString(entry.catalog),
      unavailable: support === "UNIMPLEMENTED" ? "UNIMPLEMENTED" : null,
    });
    byKey.set(key, items);
  }

  const groups: WorkflowPaletteGroup[] = [];
  for (const [key, items] of byKey) {
    groups.push({ key, label: groupLabel(key), items: items.sort(compareItems) });
  }
  return groups.sort(compareGroups);
}

/**
 * The grouping key: the category, case-folded.
 *
 * Folding is not tidiness. `category` is authored free text and the shipped
 * catalogs already spell one category two ways — `flow` in the standard pack
 * and `Flow` in a domain pack — so grouping on the raw string puts the same
 * category in two buckets. The same lesson `presentation.ts` learned for tone.
 */
function categoryKey(category: string | null | undefined): string {
  return asString(category)?.toLowerCase() ?? UNCATEGORIZED_KEY;
}

/**
 * What the group is shown as.
 *
 * Derived from the folded key rather than from whichever spelling happened to
 * arrive first, because "first" depends on catalog row order and would make
 * the heading flip between deployments. Capitalising the fold is a heading
 * every spelling of the category agrees on.
 *
 * It is also, unavoidably, untranslated: `category` is a bare string in the
 * authoring schema with no locale map beside it, unlike `label` and
 * `description`. A palette cannot localize what it was handed as one word.
 */
function groupLabel(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
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
