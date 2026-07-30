// SPDX-License-Identifier: BUSL-1.1
"use client";

import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";
import { CaseStepNodes } from "../case-step-nodes";
import { InboxMessageHandlingCaseTask } from "./task-panel";
import type {
  InboxMessageHandlingCaseContainerProps,
  InboxMessageHandlingCaseDescriptionProps,
  InboxMessageHandlingCaseProps,
  InboxMessageHandlingStepRowProps,
  InboxMessageHandlingTaskListProps,
} from "./types";

export function InboxMessageHandlingSelector({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      {...props}
      data-slot="inbox-message-handling-selector"
      className={cn(
        "pointer-events-none absolute left-4 top-[161px] h-9 w-[360px] rounded-[var(--radius-small)] bg-[var(--color-brand-indigo-10)]",
        className,
      )}
    />
  );
}

export function InboxMessageHandlingCaseContainer({
  className,
  ...props
}: InboxMessageHandlingCaseContainerProps) {
  return (
    <div
      {...props}
      data-slot="inbox-message-handling-row-case-container"
      className={cn("h-[932px] w-full shrink-0 overflow-x-hidden overflow-y-auto px-6", className)}
    />
  );
}

export function InboxMessageHandlingCase({
  className,
  ...props
}: InboxMessageHandlingCaseProps) {
  return (
    <div
      {...props}
      data-slot="inbox-message-handling-row-case"
      className={cn("flex w-[352px] flex-col", className)}
    />
  );
}

export function InboxMessageHandlingStepRow({
  nodeStep = "step",
  top = true,
  bottom = true,
  dashed = false,
  height = nodeStep === "line" ? 12 : 22,
  title,
  meta,
  railClassName,
  bodyClassName,
  className,
  children,
  ...props
}: InboxMessageHandlingStepRowProps) {
  return (
    <div
      {...props}
      data-slot="inbox-message-handling-row-step"
      data-node-step={nodeStep}
      className={cn(
        "flex w-[352px] shrink-0 items-center",
        (nodeStep === "message" || nodeStep === "step9") && "relative z-[1]",
        className,
      )}
      style={{ height, ...props.style }}
    >
      <CaseStepNodes
        step={nodeStep === "step9" ? "message" : nodeStep}
        top={top}
        bottom={bottom}
        dashed={dashed}
        className={cn("h-full", railClassName)}
      />
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col pl-4 font-sans text-[13px] font-normal leading-[13px] tracking-[-0.39px] text-[var(--color-foreground-subtle)]",
          children && nodeStep === "line" ? "justify-start" : "justify-center",
          bodyClassName,
        )}
      >
        {(title || meta) ? (
          <div className="flex min-w-0 items-center gap-0.5">
            {title ? <span className="truncate">{title}</span> : null}
            {meta ? (
              <span className="shrink-0 text-[var(--color-foreground-muted)]">
                {meta}
              </span>
            ) : null}
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}

export function InboxMessageHandlingCaseDescription({
  className,
  ...props
}: InboxMessageHandlingCaseDescriptionProps) {
  return (
    <div
      {...props}
      data-slot="inbox-message-handling-row-case-description"
      className={cn(
        "flex min-h-11 w-[320px] items-start gap-[10px] px-2",
        className,
      )}
    />
  );
}

export function InboxMessageHandlingTaskList({
  tasks = [
    "Huuropzegging goedkeuring en vastleggen",
    "Controleer huursaldo",
    "Opzegtermijn en einddatum verifieren",
    "Stuur bevestiging naar huurder",
    "Stap afronden",
  ],
  checked = false,
  className,
  children,
  ...props
}: InboxMessageHandlingTaskListProps) {
  return (
    <div
      {...props}
      data-slot="inbox-message-handling-row-task-list"
      className={cn("flex w-full flex-col gap-1", className)}
    >
      {children ??
        tasks.map((task, index) => (
          <InboxMessageHandlingCaseTask
            key={`${index}-${String(task)}`}
            label={task}
            checked={checked}
          />
        ))}
    </div>
  );
}

export { InboxMessageHandlingCaseTask } from "./task-panel";
