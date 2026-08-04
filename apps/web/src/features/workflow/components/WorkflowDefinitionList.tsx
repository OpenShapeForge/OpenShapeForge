// SPDX-License-Identifier: BUSL-1.1
"use client";

/**
 * Which workflow to open, and the three things you can do to one from here.
 *
 * Assembly. Every decision is in
 * `examples/plugins/workflow/web/definitions/` — what the two version numbers
 * mean, which rows a search matches, what order they come in, whether a name
 * may be used — because `apps/web` has no test runner and no DOM environment,
 * so a rule written here could not be tested at all. What is left is React
 * state, three dialogs and the server actions the page handed down.
 *
 * ## Filtering does not go back to the server
 *
 * `workflowDefinitions` takes a `search` argument and this screen does not use
 * it. The transport here is a server action, so every keystroke would be a
 * round trip and a full RSC re-render; a tenant's authored workflows are few
 * enough to filter in the browser, and a list that answers while you type is a
 * different screen from one that does not. The server argument stays available
 * for the deployment where that stops being true.
 *
 * ## Archiving removes the row before the refresh confirms it
 *
 * `router.refresh()` re-runs the server component, which is the truth, but it
 * is a round trip during which the archived row would still be on screen and
 * still clickable. So the id is dropped locally as soon as the action returns
 * ok, and the refresh reconciles. A failed archive adds nothing to that set,
 * so the row stays exactly where it was and the error says why.
 */
import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@openshapeforge/ui";
import { Badge } from "@/components/ui/display/badge";
import { Input } from "@/components/ui/forms/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/data-table/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/overlay/dialog";
import { cn } from "@/lib/utils";
import {
  buildWorkflowDefinitionRows,
  checkWorkflowDefinitionName,
  deriveWorkflowTriggerFilterOptions,
  formatWorkflowLastEdited,
  selectWorkflowDefinitionRows,
  WORKFLOW_DEFINITION_NAME_MAX_LENGTH,
  type WorkflowDefinitionListEntry,
  type WorkflowDefinitionListRow,
  type WorkflowDefinitionListSort,
  type WorkflowDefinitionNameRefusal,
  type WorkflowDefinitionState,
} from "../../../../../../examples/plugins/workflow/web/definitions/index";
import type {
  WorkflowActionResult,
  WorkflowDefinitionSummary,
} from "../actions/workflow-definitions";

export type WorkflowDefinitionListProps = {
  /** The definitions as the list read returned them. */
  definitions: WorkflowDefinitionListEntry[];
  /** Node type to catalog label, so a trigger reads as a word. */
  triggerLabels: Record<string, string>;
  /**
   * The clock, read once on the server.
   *
   * Both renders format against the same instant, so the relative times a
   * server render produced are the ones hydration expects to find.
   */
  nowMs: number;
  create: (name: string) => Promise<WorkflowActionResult<WorkflowDefinitionSummary>>;
  rename: (input: {
    definitionId: string;
    name: string;
  }) => Promise<WorkflowActionResult<WorkflowDefinitionSummary>>;
  archive: (
    definitionId: string,
  ) => Promise<WorkflowActionResult<WorkflowDefinitionSummary>>;
};

/** Wording for a name the rules refused. `UNCHANGED` never reaches a message. */
const NAME_REFUSAL_MESSAGE: Record<WorkflowDefinitionNameRefusal, string> = {
  EMPTY: "A workflow needs a name.",
  TOO_LONG: `A name can be at most ${WORKFLOW_DEFINITION_NAME_MAX_LENGTH} characters.`,
  UNCHANGED: "That is already the name.",
};

/**
 * What each version state is called, and how loudly.
 *
 * `PUBLISHED_WITH_DRAFT` is the one that carries information the other three do
 * not: the graph in the editor is not the graph the engine is running. It gets
 * a warning tone for that reason and not because anything is wrong.
 */
const STATE_BADGE: Record<
  WorkflowDefinitionState,
  { label: string; variant: "outline" | "secondary" | "success" | "warning" }
> = {
  EMPTY: { label: "Empty", variant: "outline" },
  DRAFT: { label: "Draft", variant: "secondary" },
  PUBLISHED: { label: "Published", variant: "success" },
  PUBLISHED_WITH_DRAFT: { label: "Unpublished changes", variant: "warning" },
};

export function WorkflowDefinitionList({
  definitions,
  triggerLabels,
  nowMs,
  create,
  rename,
  archive,
}: WorkflowDefinitionListProps) {
  const router = useRouter();

  const [search, setSearch] = useState("");
  const [triggerFilter, setTriggerFilter] = useState<string[]>([]);
  const [sort, setSort] = useState<WorkflowDefinitionListSort>("recent");
  const [archived, setArchived] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const rows = useMemo(
    () => buildWorkflowDefinitionRows({ definitions, triggerLabels }),
    [definitions, triggerLabels],
  );
  const visible = useMemo(
    () => rows.filter((row) => !archived.includes(row.id)),
    [rows, archived],
  );
  const triggerOptions = useMemo(
    () => deriveWorkflowTriggerFilterOptions(visible),
    [visible],
  );
  const shown = useMemo(
    () => selectWorkflowDefinitionRows(visible, { search, triggerTypes: triggerFilter, sort }),
    [visible, search, triggerFilter, sort],
  );

  const toggleTrigger = useCallback((type: string) => {
    setTriggerFilter((current) =>
      current.includes(type)
        ? current.filter((value) => value !== type)
        : [...current, type],
    );
  }, []);

  const handleCreate = useCallback(
    async (name: string) => {
      const checked = checkWorkflowDefinitionName({ name });
      if (!checked.ok) {
        setError(NAME_REFUSAL_MESSAGE[checked.refusal]);
        return;
      }
      setError(null);
      setBusy("create");
      const result = await create(checked.name);
      setBusy(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCreating(false);
      // Straight into the editor: a definition with no graph is not something to
      // come back to from a list, it is something to start drawing.
      router.push(`/workflow/${result.value.id}`);
    },
    [create, router],
  );

  const handleRename = useCallback(
    async (id: string, name: string, current: string) => {
      const checked = checkWorkflowDefinitionName({ name, current });
      if (!checked.ok) {
        // A rename to the name it already has is a closed dialog, not an error:
        // the user asked for a state the definition is already in.
        if (checked.refusal === "UNCHANGED") {
          setRenaming(null);
          return;
        }
        setError(NAME_REFUSAL_MESSAGE[checked.refusal]);
        return;
      }
      setError(null);
      setBusy(id);
      const result = await rename({ definitionId: id, name: checked.name });
      setBusy(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setRenaming(null);
      router.refresh();
    },
    [rename, router],
  );

  const handleArchive = useCallback(
    async (row: WorkflowDefinitionListRow) => {
      const confirmed =
        typeof window === "undefined" ||
        window.confirm(
          `Archive "${row.name}"? Runs already in flight keep going; no new run can start from it.`,
        );
      if (!confirmed) return;

      setError(null);
      setBusy(row.id);
      const result = await archive(row.id);
      setBusy(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setArchived((current) => [...current, row.id]);
      router.refresh();
    },
    [archive, router],
  );

  const filtered = search.trim().length > 0 || triggerFilter.length > 0;

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-wrap items-center gap-3">
        <div className="mr-auto flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">Workflows</h1>
          <p className="text-sm text-muted-foreground">
            {visible.length === 1 ? "1 workflow" : `${visible.length} workflows`}
            {filtered ? ` · ${shown.length} shown` : ""}
          </p>
        </div>
        <Button
          type="button"
          onClick={() => {
            setError(null);
            setCreating(true);
          }}
          disabled={busy !== null}
        >
          New workflow
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search workflows"
          aria-label="Search workflows"
          className="max-w-xs"
        />
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Sort
          <select
            value={sort}
            onChange={(event) =>
              setSort(event.target.value as WorkflowDefinitionListSort)
            }
            className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
          >
            <option value="recent">Last edited</option>
            <option value="name">Name</option>
          </select>
        </label>
        {triggerOptions.map((option) => {
          const active = triggerFilter.includes(option.type);
          return (
            <button
              key={option.type}
              type="button"
              aria-pressed={active}
              onClick={() => toggleTrigger(option.type)}
              className={cn(
                "rounded-full border border-border px-3 py-1 text-xs",
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              {option.label} ({option.count})
            </button>
          );
        })}
        {filtered ? (
          <Button
            variant="ghost"
            type="button"
            onClick={() => {
              setSearch("");
              setTriggerFilter([]);
            }}
          >
            Clear
          </Button>
        ) : null}
      </div>

      {/*
        Only while no dialog is open. A dialog covers the page, so an error
        rendered here while one is up is an error the user cannot read — which
        is the whole failure mode of a create that was refused.
      */}
      {error && !creating && renaming === null ? (
        <p className="text-destructive text-sm">{error}</p>
      ) : null}

      <div className="rounded-xl border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Published</TableHead>
              <TableHead>Draft</TableHead>
              <TableHead>Triggers</TableHead>
              <TableHead>Last edited</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground py-8 text-center">
                  {filtered
                    ? "No workflow matches that."
                    : "No workflows yet. Create one to start drawing."}
                </TableCell>
              </TableRow>
            ) : (
              shown.map((row) => {
                const badge = STATE_BADGE[row.versions.state];
                return (
                  <TableRow key={row.id}>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <Link
                          href={`/workflow/${row.id}`}
                          className="font-medium hover:underline"
                        >
                          {row.name}
                        </Link>
                        {row.description ? (
                          <span className="text-muted-foreground text-xs">
                            {row.description}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      {row.versions.publishedVersion === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        `v${row.versions.publishedVersion}`
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        {row.versions.draftVersion === null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          `v${row.versions.draftVersion}`
                        )}
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      </div>
                    </TableCell>
                    <TableCell>
                      {row.triggers.length === 0 ? (
                        // Empty until first publish: triggerTypes is derived
                        // from the PUBLISHED graph, so a draft's triggers are
                        // not knowable from a list read.
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {row.triggers.map((trigger) => (
                            <Badge key={trigger.type} variant="outline">
                              {trigger.label}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {formatWorkflowLastEdited(row.updatedAt, nowMs)}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button
                        variant="ghost"
                        type="button"
                        disabled={busy !== null}
                        onClick={() => {
                          setError(null);
                          setRenaming({ id: row.id, name: row.name });
                        }}
                      >
                        Rename
                      </Button>
                      <Button
                        variant="ghost"
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void handleArchive(row)}
                      >
                        {busy === row.id ? "Working…" : "Archive"}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <NameDialog
        open={creating}
        title="New workflow"
        description="It opens empty, in the editor. Publishing is what makes it runnable."
        confirmLabel={busy === "create" ? "Creating…" : "Create"}
        initialName=""
        busy={busy !== null}
        error={creating ? error : null}
        onCancel={() => setCreating(false)}
        onConfirm={(name) => void handleCreate(name)}
      />

      <NameDialog
        open={renaming !== null}
        title="Rename workflow"
        description="Renaming updates the definition, which invalidates the save token of any editor currently open on it."
        confirmLabel={busy !== null ? "Renaming…" : "Rename"}
        initialName={renaming?.name ?? ""}
        busy={busy !== null}
        error={renaming !== null ? error : null}
        onCancel={() => setRenaming(null)}
        onConfirm={(name) => {
          if (renaming) void handleRename(renaming.id, name, renaming.name);
        }}
      />
    </div>
  );
}

/**
 * One dialog for both create and rename, because both ask exactly one question.
 *
 * The field is uncontrolled and read out of the form on submit rather than
 * mirrored into React state. The dialog stays mounted between rows, so state
 * seeded from `initialName` would still be holding the previous row's name when
 * a second rename opened; `key` remounts the input and the DOM is then the only
 * copy there is.
 */
function NameDialog({
  open,
  title,
  description,
  confirmLabel,
  initialName,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  initialName: string;
  busy: boolean;
  /** Shown here rather than on the page, which the dialog is covering. */
  error: string | null;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const entered = new FormData(event.currentTarget).get("name");
            onConfirm(typeof entered === "string" ? entered : "");
          }}
        >
          <Input
            key={`${title}:${initialName}`}
            name="name"
            autoFocus
            defaultValue={initialName}
            placeholder="Name"
            aria-label="Workflow name"
            maxLength={WORKFLOW_DEFINITION_NAME_MAX_LENGTH}
          />
          {error ? <p className="text-destructive mt-2 text-sm">{error}</p> : null}
          <DialogFooter className="mt-4">
            <Button variant="ghost" type="button" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
