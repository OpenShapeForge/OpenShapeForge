// SPDX-License-Identifier: BUSL-1.1
"use client";

import { UserRound } from "lucide-react";

import { cn } from "../../lib/cn";
import { Button } from "../button";
import { CaseCheck } from "../case-check";
import type {
  InboxMessageHandlingActionRowProps,
  InboxMessageHandlingAssigneeProps,
  InboxMessageHandlingCaseTaskProps,
  InboxMessageHandlingFieldProps,
  InboxMessageHandlingFormFieldsProps,
  InboxMessageHandlingTaskPanelProps,
} from "./types";

export function InboxMessageHandlingCaseTask({
  label,
  description,
  state,
  checked = false,
  active = false,
  showDescription = false,
  className,
  ...props
}: InboxMessageHandlingCaseTaskProps) {
  const resolvedState =
    state ?? (active ? "in-progress" : checked ? "checked" : "active");

  return (
    <div
      {...props}
      data-slot="inbox-message-handling-case-task"
      className={cn(
        "flex h-9 w-[320px] flex-col gap-[10px] px-2 py-2",
        className,
      )}
    >
      <CaseCheck
        state={resolvedState}
        label={label}
        description={showDescription ? description : undefined}
        className="max-w-[304px]"
      />
    </div>
  );
}

export function InboxMessageHandlingTaskPanel({
  title,
  outcome = "Niet gecontroleerd",
  arrears = "0",
  note = "|",
  assignee,
  finishLabel = "Oppakken",
  className,
}: InboxMessageHandlingTaskPanelProps) {
  return (
    <div
      data-slot="inbox-message-handling-task-panel"
      className={cn(
        "relative flex w-[320px] flex-col gap-3 rounded-[var(--radius-small)] border border-[var(--color-border-subtle)] bg-[var(--color-card)] p-3",
        className,
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <InboxMessageHandlingCaseTask
          label={title}
          active={Boolean(assignee)}
          checked={!assignee}
          className="h-4 flex-1 p-0"
        />
        {assignee ? <div className="shrink-0">{assignee}</div> : null}
      </div>
      <InboxMessageHandlingFormFields
        outcome={outcome}
        arrears={arrears}
        note={note}
      />
      <InboxMessageHandlingActionRow finishLabel={finishLabel} />
    </div>
  );
}

export function InboxMessageHandlingFormFields({
  outcome = "Niet gecontroleerd",
  arrears = "0",
  note = "|",
  className,
  ...props
}: InboxMessageHandlingFormFieldsProps) {
  return (
    <div
      {...props}
      data-slot="inbox-message-handling-form-fields"
      className={cn("grid w-full gap-2 px-5", className)}
    >
      <InboxMessageHandlingField label="Uitkomst" value={outcome} hasDropdown />
      <InboxMessageHandlingField label="Achterstand" value={arrears} />
      <InboxMessageHandlingField label="Toelichting" value={note} multiline />
    </div>
  );
}

export function InboxMessageHandlingField({
  label,
  value,
  multiline = false,
  hasDropdown = false,
}: InboxMessageHandlingFieldProps) {
  return (
    <div
      data-slot="inbox-message-handling-field"
      className={cn("flex w-full flex-col gap-2", multiline ? "h-20" : "h-[54px]")}
    >
      <div className="flex items-center justify-between text-[12px] leading-3 tracking-[-0.36px]">
        <span className="text-[var(--color-foreground-subtle)]">{label}</span>
      </div>
      <div
        className={cn(
          "flex w-full rounded-[var(--radius-small)] border border-[var(--color-border-subtle)] bg-[var(--color-card)] px-2 text-[13px] font-normal leading-[22px] tracking-[-0.39px] text-[var(--color-foreground-subtle)]",
          multiline ? "h-12 items-start py-[13px]" : "h-[30px] items-center",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{value}</span>
        {hasDropdown ? (
          <span
            aria-hidden
            className="ml-2 text-[16px] leading-none text-[var(--color-foreground-muted)]"
          >
            &#8964;
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function InboxMessageHandlingActionRow({
  finishLabel = "Oppakken",
  className,
}: InboxMessageHandlingActionRowProps) {
  return (
    <div
      data-slot="inbox-message-handling-action-row"
      className={cn("flex w-full justify-end gap-2", className)}
    >
      <Button variant="outline" size="default">
        Annuleren
      </Button>
      <Button variant="primary" size="default">
        {finishLabel}
      </Button>
    </div>
  );
}

export function InboxMessageHandlingAssignee({
  name = "Albus Dumbledore",
  role = "Administrator",
  className,
}: InboxMessageHandlingAssigneeProps) {
  return (
    <div
      data-slot="inbox-message-handling-assignee"
      className={cn("flex items-center gap-2", className)}
    >
      <span className="flex size-8 items-center justify-center rounded-full bg-[var(--color-surface)] text-[var(--color-foreground-muted)]">
        <UserRound className="size-4" aria-hidden />
      </span>
      <span className="flex flex-col gap-1">
        <span className="text-[14px] font-medium leading-[14px] tracking-[-0.42px] text-[var(--color-foreground)]">
          {name}
        </span>
        <span className="text-[12px] font-normal leading-3 tracking-[-0.36px] text-[var(--color-foreground-muted)]">
          {role}
        </span>
      </span>
    </div>
  );
}
