// SPDX-License-Identifier: BUSL-1.1
"use client";

/**
 * What is wrong with this graph, before the user presses Publish.
 *
 * Publishing refuses any error-severity issue, so an editor that only reported
 * that at the moment the button was pressed would be telling an author too
 * late — after they had drawn a graph, and with no indication of which part of
 * it to look at.
 *
 * The three sections are `blocksAt`, not severity. Every issue that refuses
 * anything is an error, so severity cannot distinguish a graph that will not
 * save from one that is merely unfinished — and "unfinished" is the normal
 * state of a graph being drawn. `summarizeWorkflowValidation` makes that split
 * and this draws it.
 */
import { Badge } from "@/components/ui/display/badge";
import { cn } from "@/lib/utils";
import type {
  WorkflowValidationIssue,
  WorkflowValidationSummary,
} from "../../../../../../../examples/plugins/workflow/web/editor/index";

export type WorkflowValidationPanelProps = {
  summary: WorkflowValidationSummary;
  /** Null before the first round trip returns; drawn as "not checked yet". */
  checked: boolean;
  /** Select the node or edge an issue names. */
  onSelectNode?: (nodeId: string) => void;
  className?: string;
};

const SECTIONS = [
  {
    key: "blocksSave" as const,
    title: "Refuses a save",
    blurb:
      "The document cannot be read back as the graph it claims to be. Every writer refuses these, a patch included.",
    badge: "destructive" as const,
  },
  {
    key: "blocksPublish" as const,
    title: "Refuses a publish",
    blurb:
      "Well-formed and not runnable. This is also what an unfinished graph looks like, so these do not stop you saving.",
    badge: "warning" as const,
  },
  {
    key: "warnings" as const,
    title: "Worth knowing",
    blurb: "Reported, refusing nothing.",
    badge: "secondary" as const,
  },
];

export function WorkflowValidationPanel({
  summary,
  checked,
  onSelectNode,
  className,
}: WorkflowValidationPanelProps) {
  const total =
    summary.blocksSave.length + summary.blocksPublish.length + summary.warnings.length;

  return (
    <section className={cn("flex min-h-0 flex-col gap-3 overflow-y-auto p-4", className)}>
      <h2 className="text-sm font-medium">Validation</h2>
      {!checked ? (
        <p className="text-sm text-muted-foreground">Not checked yet.</p>
      ) : total === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing to report. This graph publishes.
        </p>
      ) : (
        SECTIONS.map((section) => {
          const issues = summary[section.key];
          if (issues.length === 0) return null;
          return (
            <div key={section.key} className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Badge variant={section.badge}>{issues.length}</Badge>
                <h3 className="text-sm font-medium">{section.title}</h3>
              </div>
              <p className="text-xs text-muted-foreground">{section.blurb}</p>
              <ul className="flex flex-col gap-1">
                {issues.map((issue, index) => (
                  <IssueRow
                    key={`${issue.code}-${issue.path}-${index}`}
                    issue={issue}
                    {...(onSelectNode ? { onSelectNode } : {})}
                  />
                ))}
              </ul>
            </div>
          );
        })
      )}
    </section>
  );
}

function IssueRow({
  issue,
  onSelectNode,
}: {
  issue: WorkflowValidationIssue;
  onSelectNode?: (nodeId: string) => void;
}) {
  const nodeId = issue.nodeId ?? null;
  const selectable = nodeId !== null && onSelectNode !== undefined;

  return (
    <li className="rounded-md border border-border/60 px-2 py-1.5 text-sm">
      <p>{issue.message}</p>
      <p className="mt-0.5 flex items-center gap-2 font-mono text-xs text-muted-foreground">
        <span>{issue.code}</span>
        {nodeId ? (
          selectable ? (
            <button
              type="button"
              className="underline underline-offset-2 hover:text-foreground"
              onClick={() => onSelectNode(nodeId)}
            >
              {nodeId}
            </button>
          ) : (
            <span>{nodeId}</span>
          )
        ) : (
          // The path, when the issue is about the document rather than about
          // one node — a reader still needs somewhere to look.
          <span>{issue.path}</span>
        )}
      </p>
    </li>
  );
}
