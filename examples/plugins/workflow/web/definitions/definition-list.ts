// SPDX-License-Identifier: BUSL-1.1
/**
 * What a list of workflow definitions says, and which of them it shows.
 *
 * The editor opened `workflowDefinitions()[0]` because there was no way to
 * choose. Choosing needs a screen, and a screen needs answers to four questions
 * the API does not answer for it:
 *
 * - **Which version is this?** `publishedVersion` and `latestVersion` are two
 *   independent nullable integers, and the four combinations they produce mean
 *   four different things to an author. Deriving that in a component would put
 *   the one derivation on this screen that can be silently wrong somewhere no
 *   test can reach it.
 * - **What starts it?** `triggerTypes` arrives as raw node types
 *   (`triggerSchedule`), which is a catalog key rather than something to show a
 *   reader.
 * - **Which rows match what I typed?** Filtering and sorting, over a list the
 *   server sends whole.
 * - **Is this name usable?** Asked by create and by rename, so it is one rule
 *   rather than two.
 *
 * Pure, like everything else under `web/`: `apps/web` has no test runner and no
 * DOM environment, so anything that can be wrong lives where `bun test
 * examples` reaches it and the component that draws it stays assembly.
 *
 * ## Sorting and filtering happen here, not in the query
 *
 * `workflowDefinitions` takes `search`, and using it would make every keystroke
 * a round trip through a server action — the transport this app has, which is a
 * form POST and a full RSC re-render. The list is a tenant's authored
 * workflows, so it is small enough to filter in the browser, and typing that
 * does not wait for a network is the whole difference between a list you can
 * scan and one you cannot. The server argument is still there for the day a
 * tenant has thousands.
 */

/** The slice of `WorkflowDefinition` a list reads. */
export type WorkflowDefinitionListEntry = {
  id: string;
  name: string;
  description?: string | null;
  /** ISO 8601, as the API serializes a timestamptz. */
  updatedAt?: string | null;
  publishedVersion?: number | null;
  latestVersion?: number | null;
  /** Trigger node types on the PUBLISHED graph. Empty until first publish. */
  triggerTypes?: readonly string[] | null;
};

/**
 * Where a definition stands between its draft and what is running.
 *
 * Four states rather than a boolean, because "has a draft" and "is published"
 * are independent and every combination happens:
 *
 * - `EMPTY` — created, never saved. There is no graph yet, so there is nothing
 *   to publish and nothing to lose.
 * - `DRAFT` — saved, never published. Nothing runs this workflow.
 * - `PUBLISHED` — the newest stored version is the published one. What an
 *   author sees when they open it is what runs.
 * - `PUBLISHED_WITH_DRAFT` — a newer version exists than the published one, so
 *   edits are live in the editor and NOT live in the engine. The one state a
 *   list must not hide, because it is the one where the screen and the running
 *   system disagree.
 */
export type WorkflowDefinitionState =
  | "EMPTY"
  | "DRAFT"
  | "PUBLISHED"
  | "PUBLISHED_WITH_DRAFT";

export type WorkflowDefinitionVersions = {
  state: WorkflowDefinitionState;
  publishedVersion: number | null;
  /**
   * The newest stored version — what the editor opens. Equal to
   * `publishedVersion` when nothing has been saved since the publish.
   */
  draftVersion: number | null;
  hasUnpublishedChanges: boolean;
};

/**
 * The four states, from two nullable integers.
 *
 * `publishedVersion > draftVersion` cannot happen — a published version IS a
 * stored version, so the newest stored one is at least as new — but it is not
 * refused here. `latestVersion` and `publishedVersion` are computed by two
 * different lateral joins, and a list that threw on disagreeing rows would take
 * the whole screen down over one. The published number is trusted (it names
 * something that ran) and the draft is raised to meet it, which reads as
 * `PUBLISHED`: the honest answer when the only evidence of a newer draft is an
 * inconsistency.
 */
export function describeWorkflowDefinitionVersions(input: {
  publishedVersion?: number | null;
  latestVersion?: number | null;
}): WorkflowDefinitionVersions {
  const published = asVersion(input.publishedVersion);
  const latest = asVersion(input.latestVersion);
  const draft =
    latest === null
      ? published
      : published === null
        ? latest
        : Math.max(latest, published);

  if (draft === null) {
    return {
      state: "EMPTY",
      publishedVersion: null,
      draftVersion: null,
      hasUnpublishedChanges: false,
    };
  }
  if (published === null) {
    return {
      state: "DRAFT",
      publishedVersion: null,
      draftVersion: draft,
      hasUnpublishedChanges: true,
    };
  }
  return {
    state: draft > published ? "PUBLISHED_WITH_DRAFT" : "PUBLISHED",
    publishedVersion: published,
    draftVersion: draft,
    hasUnpublishedChanges: draft > published,
  };
}

/** A trigger on the published graph, with the name to show for it. */
export type WorkflowTriggerSummary = {
  /** The catalog node type, which is also the filter value. */
  type: string;
  label: string;
};

export type WorkflowDefinitionListRow = {
  id: string;
  name: string;
  description: string | null;
  versions: WorkflowDefinitionVersions;
  /** Sorted and de-duplicated, so two rows with the same triggers read alike. */
  triggers: WorkflowTriggerSummary[];
  updatedAt: string | null;
  /** Epoch milliseconds, or null when `updatedAt` is missing or unreadable. */
  updatedAtMs: number | null;
};

export type BuildWorkflowDefinitionRowsInput = {
  definitions: ReadonlyArray<WorkflowDefinitionListEntry>;
  /**
   * Node type to display name, from the node catalog. Optional: the catalog is
   * a second read, and a list that could not make it still has to render.
   */
  triggerLabels?: Readonly<Record<string, string>>;
};

export function buildWorkflowDefinitionRows(
  input: BuildWorkflowDefinitionRowsInput,
): WorkflowDefinitionListRow[] {
  const rows: WorkflowDefinitionListRow[] = [];

  for (const entry of input.definitions) {
    const id = asString(entry?.id);
    // A row with no id cannot be linked to or acted on, and a row that does
    // nothing when clicked is worse than an absent one.
    if (!id) continue;

    const updatedAt = asString(entry.updatedAt);
    rows.push({
      id,
      name: asString(entry.name) ?? id,
      description: asString(entry.description),
      versions: describeWorkflowDefinitionVersions(entry),
      triggers: summarizeTriggerTypes(entry.triggerTypes, input.triggerLabels),
      updatedAt,
      updatedAtMs: parseTimestamp(updatedAt),
    });
  }

  return rows;
}

export type WorkflowDefinitionListSort = "recent" | "name";

export type WorkflowDefinitionListView = {
  /** Matched against name, description and trigger labels. */
  search?: string;
  /** Node types; a row matches when it carries ANY of them. */
  triggerTypes?: readonly string[];
  sort?: WorkflowDefinitionListSort;
};

/**
 * The rows to draw, in the order to draw them.
 *
 * Filtering is OR within the trigger selection and AND across the two
 * dimensions, which is what a reader means by ticking two triggers and typing a
 * word: "either of these, and matching that".
 *
 * The sort is total. Ties on the sort key fall through to the name and then to
 * the id, so a list of definitions saved in the same second — a seeded tenant,
 * an import — does not reorder itself between two renders of the same data.
 */
export function selectWorkflowDefinitionRows(
  rows: ReadonlyArray<WorkflowDefinitionListRow>,
  view: WorkflowDefinitionListView = {},
): WorkflowDefinitionListRow[] {
  const search = (view.search ?? "").trim().toLowerCase();
  const triggerTypes = new Set(
    (view.triggerTypes ?? []).map((type) => asString(type)).filter(isString),
  );

  const filtered = rows.filter((row) => {
    if (triggerTypes.size > 0) {
      if (!row.triggers.some((trigger) => triggerTypes.has(trigger.type))) {
        return false;
      }
    }
    if (search.length > 0 && !matchesSearch(row, search)) return false;
    return true;
  });

  return filtered.sort(view.sort === "name" ? compareByName : compareByRecency);
}

/**
 * The trigger filter's options, derived from the rows rather than from the
 * catalog.
 *
 * A catalog-wide list would offer every trigger type this deployment knows,
 * most of which no definition uses, and ticking one of those yields an empty
 * list. Offering only what is actually present means every option changes the
 * result.
 */
export function deriveWorkflowTriggerFilterOptions(
  rows: ReadonlyArray<WorkflowDefinitionListRow>,
): Array<{ type: string; label: string; count: number }> {
  const byType = new Map<string, { type: string; label: string; count: number }>();

  for (const row of rows) {
    for (const trigger of row.triggers) {
      const existing = byType.get(trigger.type);
      if (existing) {
        existing.count += 1;
      } else {
        byType.set(trigger.type, { ...trigger, count: 1 });
      }
    }
  }

  return Array.from(byType.values()).sort(
    (left, right) =>
      left.label.localeCompare(right.label) || left.type.localeCompare(right.type),
  );
}

/**
 * A node type as a reader's word for it.
 *
 * The catalog's own label wins when there is one. The fallback splits the type
 * — `triggerSchedule` is "Schedule" — because a catalog read is a second query
 * a list should not have to make, and `triggerSchedule` on screen is worse than
 * an imperfect English word.
 */
export function describeWorkflowTriggerType(
  type: string,
  labels?: Readonly<Record<string, string>>,
): string {
  return asString(labels?.[type]) ?? humanizeTriggerType(type);
}

/**
 * "Last edited", relative, against a caller-supplied now.
 *
 * `now` is a parameter and not `Date.now()` so this is testable and so the
 * server and the browser agree: a server component renders the row, React
 * hydrates it, and a clock read on each side would produce two different
 * strings for the same row and a hydration mismatch. The page reads the clock
 * once and both sides format against that.
 *
 * Beyond a week it degrades to the calendar date rather than "5 weeks ago",
 * which nobody can act on. The date is the ISO string's own — UTC, not the
 * viewer's zone — because a locale-formatted date differs between the server
 * render and the client one for exactly the same reason the clock does.
 */
export function formatWorkflowLastEdited(
  updatedAt: string | null | undefined,
  nowMs: number,
): string {
  const timestamp = parseTimestamp(asString(updatedAt));
  if (timestamp === null) return "Unknown";

  const elapsed = nowMs - timestamp;
  // A row edited "in the future" is clock skew between the API host and this
  // one, not a fact about the definition. It reads as just-edited.
  if (elapsed < MINUTE_MS) return "Just now";
  if (elapsed < HOUR_MS) return plural(Math.floor(elapsed / MINUTE_MS), "minute");
  if (elapsed < DAY_MS) return plural(Math.floor(elapsed / HOUR_MS), "hour");
  if (elapsed < WEEK_MS) return plural(Math.floor(elapsed / DAY_MS), "day");
  return (asString(updatedAt) ?? "").slice(0, 10);
}

/** Why a name was refused. */
export type WorkflowDefinitionNameRefusal = "EMPTY" | "TOO_LONG" | "UNCHANGED";

export type WorkflowDefinitionNameCheck =
  | { ok: true; name: string }
  | { ok: false; refusal: WorkflowDefinitionNameRefusal };

/**
 * The upper bound on a definition name.
 *
 * The column is `text` and constrains nothing, so this is a display decision
 * rather than a schema one: a name is the whole content of a list row, and one
 * long enough to be a description makes every other row unreadable. Refused
 * here rather than truncated on screen, because a truncated name is one the
 * author cannot tell apart from another truncated name.
 */
export const WORKFLOW_DEFINITION_NAME_MAX_LENGTH = 120;

/**
 * One rule for create and for rename.
 *
 * `UNCHANGED` is why rename passes `current`: `updateWorkflowDefinition` stamps
 * `updated_at` on every write, and that column is the optimistic-concurrency
 * token every open editor is holding. Sending a rename to the name it already
 * has would invalidate every outstanding save for no change at all.
 */
export function checkWorkflowDefinitionName(input: {
  name: string;
  /** The name it has now, when this is a rename. */
  current?: string | null;
}): WorkflowDefinitionNameCheck {
  const name = (input.name ?? "").trim();
  if (name.length === 0) return { ok: false, refusal: "EMPTY" };
  if (name.length > WORKFLOW_DEFINITION_NAME_MAX_LENGTH) {
    return { ok: false, refusal: "TOO_LONG" };
  }
  const current = asString(input.current);
  if (current !== null && current === name) {
    return { ok: false, refusal: "UNCHANGED" };
  }
  return { ok: true, name };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

function summarizeTriggerTypes(
  types: readonly string[] | null | undefined,
  labels: Readonly<Record<string, string>> | undefined,
): WorkflowTriggerSummary[] {
  const seen = new Set<string>();
  const triggers: WorkflowTriggerSummary[] = [];

  for (const value of types ?? []) {
    const type = asString(value);
    if (!type || seen.has(type)) continue;
    seen.add(type);
    triggers.push({ type, label: describeWorkflowTriggerType(type, labels) });
  }

  return triggers.sort(
    (left, right) =>
      left.label.localeCompare(right.label) || left.type.localeCompare(right.type),
  );
}

function matchesSearch(row: WorkflowDefinitionListRow, search: string): boolean {
  if (row.name.toLowerCase().includes(search)) return true;
  if (row.description !== null && row.description.toLowerCase().includes(search)) {
    return true;
  }
  // Trigger LABELS, not types: the reader searches for what the screen shows
  // them, and "Schedule" is on screen while `triggerSchedule` is not.
  return row.triggers.some((trigger) => trigger.label.toLowerCase().includes(search));
}

function compareByName(
  left: WorkflowDefinitionListRow,
  right: WorkflowDefinitionListRow,
): number {
  // Numeric collation, so "Step 2" precedes "Step 10" — authored names are
  // numbered far more often than they are not.
  return (
    left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }) ||
    left.id.localeCompare(right.id)
  );
}

function compareByRecency(
  left: WorkflowDefinitionListRow,
  right: WorkflowDefinitionListRow,
): number {
  // A row whose timestamp could not be read sorts last rather than first: it is
  // missing information, not a very old edit.
  const leftMs = left.updatedAtMs ?? Number.NEGATIVE_INFINITY;
  const rightMs = right.updatedAtMs ?? Number.NEGATIVE_INFINITY;
  if (leftMs !== rightMs) return rightMs - leftMs;
  return compareByName(left, right);
}

/**
 * `triggerSchedule` as "Schedule".
 *
 * The prefix is the runtime's own trigger predicate (`isTriggerNodeType`), so
 * stripping it leaves the part that distinguishes one trigger from another. A
 * type that is exactly `trigger` keeps its whole self rather than becoming an
 * empty label.
 */
function humanizeTriggerType(type: string): string {
  const stripped = type.startsWith("trigger") ? type.slice("trigger".length) : type;
  const words = (stripped.trim().length > 0 ? stripped : type)
    .replace(/[._-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : type;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

function asVersion(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseTimestamp(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isString(value: string | null): value is string {
  return value !== null;
}
