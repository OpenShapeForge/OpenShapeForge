// SPDX-License-Identifier: BUSL-1.1
/**
 * What the definition list says, and which rows it shows.
 *
 * Two of these carry more than the rest. The version derivation is pinned on
 * all four combinations of two nullable integers, because
 * `PUBLISHED_WITH_DRAFT` — edits saved but not published — is the state where
 * the screen and the running engine disagree, and the one a list must never
 * report as plain `PUBLISHED`. The trigger fallback is pinned against the
 * runtime's own `isTriggerNodeType`, so the prefix this module strips and the
 * prefix the engine matches on cannot drift apart.
 *
 * Run (repo root):
 *   set -o pipefail; bun test examples/plugins/workflow/web/definitions/__tests__/definition-list.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import { isTriggerNodeType } from "../../../runtime/definition-types.js";
import {
  buildWorkflowDefinitionRows,
  checkWorkflowDefinitionName,
  deriveWorkflowTriggerFilterOptions,
  describeWorkflowDefinitionVersions,
  describeWorkflowTriggerType,
  formatWorkflowLastEdited,
  selectWorkflowDefinitionRows,
  WORKFLOW_DEFINITION_NAME_MAX_LENGTH,
  type WorkflowDefinitionListEntry,
} from "../definition-list.js";

function entry(
  overrides: Partial<WorkflowDefinitionListEntry> = {},
): WorkflowDefinitionListEntry {
  return {
    id: "def-1",
    name: "Onboarding",
    description: null,
    updatedAt: "2026-08-01T10:00:00.000Z",
    publishedVersion: null,
    latestVersion: null,
    triggerTypes: [],
    ...overrides,
  };
}

function rows(entries: WorkflowDefinitionListEntry[]) {
  return buildWorkflowDefinitionRows({ definitions: entries });
}

describe("describeWorkflowDefinitionVersions", () => {
  test("a definition with no version at all is EMPTY, not a draft", () => {
    // Created and never saved. Reporting "draft v0" would name a version that
    // does not exist and offer a publish that cannot succeed.
    expect(
      describeWorkflowDefinitionVersions({ publishedVersion: null, latestVersion: null }),
    ).toEqual({
      state: "EMPTY",
      publishedVersion: null,
      draftVersion: null,
      hasUnpublishedChanges: false,
    });
  });

  test("saved but never published is DRAFT, and nothing runs it", () => {
    expect(
      describeWorkflowDefinitionVersions({ publishedVersion: null, latestVersion: 3 }),
    ).toEqual({
      state: "DRAFT",
      publishedVersion: null,
      draftVersion: 3,
      hasUnpublishedChanges: true,
    });
  });

  test("the newest version being the published one is PUBLISHED", () => {
    expect(
      describeWorkflowDefinitionVersions({ publishedVersion: 4, latestVersion: 4 }),
    ).toEqual({
      state: "PUBLISHED",
      publishedVersion: 4,
      draftVersion: 4,
      hasUnpublishedChanges: false,
    });
  });

  test("a newer draft than the published version is its own state", () => {
    // The state where the editor and the engine disagree. Collapsing it into
    // PUBLISHED would tell an author their edits are live when they are not.
    expect(
      describeWorkflowDefinitionVersions({ publishedVersion: 4, latestVersion: 7 }),
    ).toEqual({
      state: "PUBLISHED_WITH_DRAFT",
      publishedVersion: 4,
      draftVersion: 7,
      hasUnpublishedChanges: true,
    });
  });

  test("a published version newer than the latest one does not claim a draft", () => {
    // Cannot happen: the two come from separate lateral joins, and a published
    // version IS a stored one. If they ever disagree the published number is
    // the one that names something that ran.
    expect(
      describeWorkflowDefinitionVersions({ publishedVersion: 9, latestVersion: 2 }),
    ).toEqual({
      state: "PUBLISHED",
      publishedVersion: 9,
      draftVersion: 9,
      hasUnpublishedChanges: false,
    });
  });
});

describe("buildWorkflowDefinitionRows", () => {
  test("drops a row with no id rather than rendering one nothing can open", () => {
    const built = rows([entry(), entry({ id: "  " })] as WorkflowDefinitionListEntry[]);
    expect(built.map((row) => row.id)).toEqual(["def-1"]);
  });

  test("de-duplicates trigger types and orders them by label", () => {
    const [row] = rows([
      entry({ triggerTypes: ["triggerWebhook", "triggerManual", "triggerWebhook"] }),
    ]);
    expect(row!.triggers.map((trigger) => trigger.label)).toEqual(["Manual", "Webhook"]);
  });

  test("an unreadable updatedAt is null rather than an invalid date", () => {
    const [row] = rows([entry({ updatedAt: "whenever" })]);
    expect(row!.updatedAtMs).toBeNull();
  });

  test("the catalog's own label wins over the derived one", () => {
    const built = buildWorkflowDefinitionRows({
      definitions: [entry({ triggerTypes: ["triggerSchedule"] })],
      triggerLabels: { triggerSchedule: "Planned start" },
    });
    expect(built[0]!.triggers[0]!.label).toBe("Planned start");
  });
});

describe("describeWorkflowTriggerType", () => {
  test("strips the prefix the runtime matches triggers on", () => {
    // Sourced from the runtime rather than restated, so a change to what counts
    // as a trigger fails here instead of leaving the list with a stale prefix.
    for (const type of ["triggerManual", "triggerSchedule", "triggerWebhook"]) {
      expect(isTriggerNodeType(type)).toBe(true);
      expect(describeWorkflowTriggerType(type)).toBe(type.slice("trigger".length));
    }
  });

  test("a type that is only the prefix keeps its whole self", () => {
    expect(describeWorkflowTriggerType("trigger")).toBe("Trigger");
  });

  test("splits a camelCase remainder into words", () => {
    expect(describeWorkflowTriggerType("triggerEntityCreated")).toBe("Entity created");
  });
});

describe("selectWorkflowDefinitionRows", () => {
  const catalog = rows([
    entry({
      id: "a",
      name: "Invoice approval",
      updatedAt: "2026-08-01T10:00:00.000Z",
      triggerTypes: ["triggerManual"],
    }),
    entry({
      id: "b",
      name: "Nightly export",
      description: "Pushes yesterday's rows to the warehouse.",
      updatedAt: "2026-08-03T10:00:00.000Z",
      triggerTypes: ["triggerSchedule"],
    }),
    entry({
      id: "c",
      name: "Inbound webhook",
      updatedAt: "2026-08-02T10:00:00.000Z",
      triggerTypes: ["triggerWebhook", "triggerManual"],
    }),
  ]);

  test("defaults to most recently edited first", () => {
    expect(selectWorkflowDefinitionRows(catalog).map((row) => row.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  test("sorts names numerically, so Step 2 precedes Step 10", () => {
    const numbered = rows([
      entry({ id: "x", name: "Step 10" }),
      entry({ id: "y", name: "Step 2" }),
    ]);
    expect(
      selectWorkflowDefinitionRows(numbered, { sort: "name" }).map((row) => row.name),
    ).toEqual(["Step 2", "Step 10"]);
  });

  test("search reaches the description and the trigger label, not only the name", () => {
    expect(
      selectWorkflowDefinitionRows(catalog, { search: "warehouse" }).map((row) => row.id),
    ).toEqual(["b"]);
    // "Schedule" is what the screen shows; `triggerSchedule` is not.
    expect(
      selectWorkflowDefinitionRows(catalog, { search: "schedule" }).map((row) => row.id),
    ).toEqual(["b"]);
  });

  test("two selected triggers mean either of them, and the search still applies", () => {
    expect(
      selectWorkflowDefinitionRows(catalog, {
        triggerTypes: ["triggerManual", "triggerSchedule"],
      }).map((row) => row.id),
    ).toEqual(["b", "c", "a"]);
    expect(
      selectWorkflowDefinitionRows(catalog, {
        triggerTypes: ["triggerManual", "triggerSchedule"],
        search: "invoice",
      }).map((row) => row.id),
    ).toEqual(["a"]);
  });

  test("rows edited in the same instant keep one order", () => {
    // Otherwise a seeded tenant reshuffles between two renders of one dataset.
    const tied = rows([
      entry({ id: "second", name: "Beta", updatedAt: "2026-08-01T10:00:00.000Z" }),
      entry({ id: "first", name: "Alpha", updatedAt: "2026-08-01T10:00:00.000Z" }),
    ]);
    expect(selectWorkflowDefinitionRows(tied).map((row) => row.name)).toEqual([
      "Alpha",
      "Beta",
    ]);
  });

  test("a row with no readable timestamp sorts last, not first", () => {
    const mixed = rows([
      entry({ id: "unknown", name: "Unknown", updatedAt: null }),
      entry({ id: "known", name: "Known", updatedAt: "2020-01-01T00:00:00.000Z" }),
    ]);
    expect(selectWorkflowDefinitionRows(mixed).map((row) => row.id)).toEqual([
      "known",
      "unknown",
    ]);
  });

  test("does not mutate the rows it was handed", () => {
    const source = [...catalog];
    selectWorkflowDefinitionRows(catalog, { sort: "name" });
    expect(catalog).toEqual(source);
  });
});

describe("deriveWorkflowTriggerFilterOptions", () => {
  test("offers only triggers some definition actually uses, with their counts", () => {
    // A catalog-wide list would offer options that filter to nothing.
    const built = rows([
      entry({ id: "a", triggerTypes: ["triggerManual"] }),
      entry({ id: "b", triggerTypes: ["triggerManual", "triggerSchedule"] }),
      entry({ id: "c", triggerTypes: [] }),
    ]);
    expect(deriveWorkflowTriggerFilterOptions(built)).toEqual([
      { type: "triggerManual", label: "Manual", count: 2 },
      { type: "triggerSchedule", label: "Schedule", count: 1 },
    ]);
  });
});

describe("formatWorkflowLastEdited", () => {
  const now = Date.parse("2026-08-04T12:00:00.000Z");

  test("reads relative up to a week and falls back to the date beyond it", () => {
    expect(formatWorkflowLastEdited("2026-08-04T11:59:30.000Z", now)).toBe("Just now");
    expect(formatWorkflowLastEdited("2026-08-04T11:59:00.000Z", now)).toBe("1 minute ago");
    expect(formatWorkflowLastEdited("2026-08-04T11:00:00.000Z", now)).toBe("1 hour ago");
    expect(formatWorkflowLastEdited("2026-08-01T12:00:00.000Z", now)).toBe("3 days ago");
    expect(formatWorkflowLastEdited("2026-06-01T09:14:00.000Z", now)).toBe("2026-06-01");
  });

  test("a timestamp in the future is clock skew, not a fact about the row", () => {
    expect(formatWorkflowLastEdited("2026-08-04T12:00:30.000Z", now)).toBe("Just now");
  });

  test("says so when there is no readable timestamp", () => {
    expect(formatWorkflowLastEdited(null, now)).toBe("Unknown");
    expect(formatWorkflowLastEdited("whenever", now)).toBe("Unknown");
  });
});

describe("checkWorkflowDefinitionName", () => {
  test("trims, and refuses a name that is only whitespace", () => {
    expect(checkWorkflowDefinitionName({ name: "  Onboarding  " })).toEqual({
      ok: true,
      name: "Onboarding",
    });
    expect(checkWorkflowDefinitionName({ name: "   " })).toEqual({
      ok: false,
      refusal: "EMPTY",
    });
  });

  test("refuses a name too long to tell apart in a list", () => {
    expect(
      checkWorkflowDefinitionName({
        name: "x".repeat(WORKFLOW_DEFINITION_NAME_MAX_LENGTH + 1),
      }),
    ).toEqual({ ok: false, refusal: "TOO_LONG" });
    expect(
      checkWorkflowDefinitionName({ name: "x".repeat(WORKFLOW_DEFINITION_NAME_MAX_LENGTH) }).ok,
    ).toBe(true);
  });

  test("a rename to the name it already has is refused, not sent", () => {
    // Every write stamps updated_at, which is the concurrency token every open
    // editor holds. A no-op rename would invalidate all of them.
    expect(
      checkWorkflowDefinitionName({ name: " Onboarding ", current: "Onboarding" }),
    ).toEqual({ ok: false, refusal: "UNCHANGED" });
    // Create passes no current name, so a definition may be named after one
    // that already exists — the store allows it and this is not the gate.
    expect(checkWorkflowDefinitionName({ name: "Onboarding" }).ok).toBe(true);
  });
});
