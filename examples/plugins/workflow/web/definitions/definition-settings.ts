// SPDX-License-Identifier: BUSL-1.1
/**
 * A definition's metadata — name, description, category — and what a settings
 * screen may send when an author changes it.
 *
 * Metadata, not graph. `updateWorkflowDefinition` reaches none of the document:
 * changing what a workflow DOES is a version, and versions are what
 * `saveWorkflowDefinitionVersion` appends. That separation is why this file
 * exists rather than the settings riding along on the graph save — the two
 * write through different mutations, and one of them is not versioned at all.
 *
 * Pure, like everything else under `web/`, because `apps/web` has no test
 * runner. What can be wrong here is the diff, and the diff is the whole point:
 *
 * ## Only what changed, and never nothing
 *
 * `updateWorkflowDefinition` refuses an update naming no field — BAD_USER_INPUT,
 * with its own note that "an update with nothing in it would still bump
 * `updated_at` and invalidate every outstanding save token". That token is
 * `expectedUpdatedAt`, which the open editor is holding, so **every settings
 * write costs the editor its next save unless the editor adopts the new
 * timestamp.** Sending fields that did not change costs the same for no reason.
 *
 * So {@link diffWorkflowDefinitionSettings} returns exactly the fields that
 * differ, and returns "nothing to do" as its own answer rather than as an empty
 * input the server will reject.
 *
 * ## An empty description is null, not `""`
 *
 * `optionalText` on the server turns blank into null, and the read path serves
 * `description: String` as null. Sending `""` therefore stores null and the
 * next diff would see no change — correct by accident. It is done here anyway,
 * so that the value this module says it is sending is the value that lands.
 */
import {
  checkWorkflowDefinitionName,
  type WorkflowDefinitionNameRefusal,
} from "./definition-list";

/**
 * The categories a definition may carry, mirroring
 * `WORKFLOW_DEFINITION_CATEGORIES` in `runtime/definition-types.ts`.
 *
 * Not imported from there. That module is compiled with NodeNext and reached by
 * the API, and this one is bundled for the browser; the two already sit either
 * side of that line deliberately (see `web/tsconfig.json`). Two lists is a real
 * cost, and the alternative — a settings form whose options depend on a
 * server-only module — is a larger one. `definition-settings.test.ts` pins them
 * together, so a category added there fails here rather than silently going
 * unofferable.
 */
export const WORKFLOW_DEFINITION_CATEGORY_OPTIONS = [
  {
    value: "process",
    label: "Process",
    description: "A workflow the engine runs from a trigger.",
  },
  {
    value: "orchestrator",
    label: "Orchestrator",
    description: "Reserved. Nothing runs one yet; see the plugin's table comment.",
  },
] as const;

export type WorkflowDefinitionCategoryOption =
  (typeof WORKFLOW_DEFINITION_CATEGORY_OPTIONS)[number]["value"];

/** The three fields a settings sheet edits, as the API serves and takes them. */
export type WorkflowDefinitionSettings = {
  name: string;
  description: string | null;
  category: WorkflowDefinitionCategoryOption;
};

/** Only the fields that changed. Never empty; see {@link diffWorkflowDefinitionSettings}. */
export type WorkflowDefinitionSettingsChange = {
  name?: string;
  description?: string | null;
  category?: WorkflowDefinitionCategoryOption;
};

export type WorkflowDefinitionSettingsDiff =
  | { ok: true; change: WorkflowDefinitionSettingsChange; changed: readonly string[] }
  /** Nothing differs. Not an error, and not something to send. */
  | { ok: false; refusal: "UNCHANGED" }
  /** The name is unusable. Codes are `checkWorkflowDefinitionName`'s own. */
  | { ok: false; refusal: WorkflowDefinitionNameRefusal };

/**
 * The settings a definition record is currently carrying.
 *
 * Tolerant of what it is handed because the caller is a GraphQL result: a
 * category the schema does not have yet reads as `process`, which is the only
 * one anything runs, and a blank description is null rather than `""` so that
 * the diff against a cleared field is empty rather than a write.
 */
export function readWorkflowDefinitionSettings(definition: {
  name?: string | null;
  description?: string | null;
  category?: string | null;
}): WorkflowDefinitionSettings {
  return {
    name: (definition.name ?? "").trim(),
    description: normalizeDescription(definition.description),
    category: asCategory(definition.category),
  };
}

/**
 * What to send, given what the author typed and what the definition holds.
 *
 * The name goes through `checkWorkflowDefinitionName` — one rule for create,
 * rename and this — but its `UNCHANGED` refusal is NOT propagated: a settings
 * sheet that only changed the description is a legitimate write, and only the
 * name is left out of it. `UNCHANGED` here means all three agree.
 */
export function diffWorkflowDefinitionSettings(input: {
  current: WorkflowDefinitionSettings;
  next: {
    name: string;
    description: string | null;
    category: string;
  };
}): WorkflowDefinitionSettingsDiff {
  const checked = checkWorkflowDefinitionName({
    name: input.next.name,
    current: input.current.name,
  });
  if (!checked.ok && checked.refusal !== "UNCHANGED") {
    return { ok: false, refusal: checked.refusal };
  }

  const change: WorkflowDefinitionSettingsChange = {};
  const changed: string[] = [];

  if (checked.ok) {
    change.name = checked.name;
    changed.push("name");
  }

  const description = normalizeDescription(input.next.description);
  if (description !== input.current.description) {
    change.description = description;
    changed.push("description");
  }

  const category = asCategory(input.next.category);
  if (category !== input.current.category) {
    change.category = category;
    changed.push("category");
  }

  if (changed.length === 0) return { ok: false, refusal: "UNCHANGED" };
  return { ok: true, change, changed };
}

/** Blank, whitespace and absent are all "no description", which is null. */
function normalizeDescription(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  return text.length === 0 ? null : text;
}

function asCategory(value: unknown): WorkflowDefinitionCategoryOption {
  return WORKFLOW_DEFINITION_CATEGORY_OPTIONS.some((option) => option.value === value)
    ? (value as WorkflowDefinitionCategoryOption)
    : "process";
}
