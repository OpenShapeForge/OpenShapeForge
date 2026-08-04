// SPDX-License-Identifier: BUSL-1.1
"use client";

/**
 * A definition's name, description and category.
 *
 * Assembly. What may be sent, what a blank description means and what "nothing
 * changed" is are in
 * `examples/plugins/workflow/web/definitions/definition-settings.ts`, where
 * `bun test examples` reaches them; `apps/web` has neither a test runner nor a
 * DOM environment.
 *
 * ## Why it saves on its own rather than with the graph
 *
 * These three are not in the document. `updateWorkflowDefinition` writes the
 * definition row and `saveWorkflowDefinitionVersion` appends a version, and the
 * two are separate on purpose: metadata is not versioned, so folding it into
 * the graph save would make renaming a workflow produce a new version of it.
 *
 * The consequence the caller has to handle is stated on the action: this write
 * stamps `updated_at`, which IS the `expectedUpdatedAt` the open editor is
 * holding. The editor adopts the refreshed value from the result. Without that
 * an author who renames their workflow loses their next save to a stale-token
 * error, having changed nothing about the graph.
 *
 * ## And why it is not on the undo stack
 *
 * Undo walks back the canvas document. These fields are already written when
 * the sheet closes — there is nothing local to walk back to, and an undo that
 * reissued the mutation would be a network write triggered by Ctrl+Z. Reverting
 * a rename is another rename.
 *
 * ## A dialog, given side-panel geometry
 *
 * There is no `Sheet` primitive in `components/ui`, and adding one for this
 * would be a design-system change riding along in a feature slice. Radix's
 * dialog is the same primitive a sheet is built on; the geometry is a class
 * list, and `cn` merges it over the centred default.
 */
import { useEffect, useState } from "react";
import { Button } from "@openshapeforge/ui";
import { Input } from "@/components/ui/forms/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/overlay/dialog";
import {
  diffWorkflowDefinitionSettings,
  WORKFLOW_DEFINITION_CATEGORY_OPTIONS,
  WORKFLOW_DEFINITION_NAME_MAX_LENGTH,
  type WorkflowDefinitionSettings,
  type WorkflowDefinitionSettingsChange,
} from "../../../../../../../examples/plugins/workflow/web/definitions/index";

export type DefinitionSettingsSheetProps = {
  open: boolean;
  /** The settings as the definition currently holds them. */
  settings: WorkflowDefinitionSettings;
  /** No lock, no writes. The sheet still opens, so the values can be read. */
  readOnly?: boolean;
  /**
   * A write is already in flight, whichever one.
   *
   * Not only a settings write: this one stamps `updated_at`, which is the token
   * a graph save in flight is presenting, so starting it mid-save would make
   * that save fail on a token this editor invalidated itself.
   */
  busy?: boolean;
  /** Only the fields that differ; never called when none do. */
  onSave: (change: WorkflowDefinitionSettingsChange) => void;
  onOpenChange: (open: boolean) => void;
};

/** Wording for a name the rules refused. `UNCHANGED` never reaches a message. */
const REFUSAL_MESSAGE: Record<string, string> = {
  EMPTY: "A workflow needs a name.",
  TOO_LONG: `A name can be at most ${WORKFLOW_DEFINITION_NAME_MAX_LENGTH} characters.`,
  UNCHANGED: "Nothing to save.",
};

export function DefinitionSettingsSheet({
  open,
  settings,
  readOnly = false,
  busy = false,
  onSave,
  onOpenChange,
}: DefinitionSettingsSheetProps) {
  const [draft, setDraft] = useState(settings);
  const [error, setError] = useState<string | null>(null);

  // Reseeded when the sheet opens and when a save returns a new record, so a
  // second open never shows the values from the first. Depends on the settings
  // OBJECT rather than on its fields, which is what makes it fire exactly when
  // the definition the editor is holding actually changed.
  useEffect(() => {
    if (!open) return;
    setDraft(settings);
    setError(null);
  }, [open, settings]);

  const handleSave = () => {
    const diff = diffWorkflowDefinitionSettings({ current: settings, next: draft });
    if (!diff.ok) {
      // "Nothing changed" closes rather than complains: the user asked for a
      // state the definition is already in.
      if (diff.refusal === "UNCHANGED") {
        onOpenChange(false);
        return;
      }
      setError(REFUSAL_MESSAGE[diff.refusal] ?? diff.refusal);
      return;
    }
    setError(null);
    onSave(diff.change);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* `cn` is tailwind-merge, so each of these wins its own group over the
          centred default: a full-height panel against the right edge. */}
      <DialogContent className="top-0 right-0 bottom-0 left-auto flex h-full w-full max-w-xl translate-x-0 translate-y-0 flex-col gap-6 overflow-y-auto rounded-none">
        <DialogHeader>
          <DialogTitle>Workflow settings</DialogTitle>
          <DialogDescription>
            Name, description and category. None of these is part of the graph,
            so saving them here does not create a version — but it does refresh
            the token this editor saves with.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Name</span>
            <Input
              value={draft.name}
              disabled={readOnly}
              maxLength={WORKFLOW_DEFINITION_NAME_MAX_LENGTH}
              aria-label="Workflow name"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Description</span>
            <textarea
              value={draft.description ?? ""}
              disabled={readOnly}
              rows={4}
              aria-label="Workflow description"
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Category</span>
            <select
              value={draft.category}
              disabled={readOnly}
              aria-label="Workflow category"
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
              onChange={(event) =>
                setDraft({
                  ...draft,
                  category: event.target.value as WorkflowDefinitionSettings["category"],
                })
              }
            >
              {WORKFLOW_DEFINITION_CATEGORY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted-foreground">
              {
                WORKFLOW_DEFINITION_CATEGORY_OPTIONS.find(
                  (option) => option.value === draft.category,
                )?.description
              }
            </span>
          </label>

          {error ? <p className="text-destructive text-sm">{error}</p> : null}
        </div>

        <DialogFooter className="mt-auto">
          <Button variant="ghost" type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={readOnly || busy}>
            {busy ? "Saving…" : "Save settings"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
