// SPDX-License-Identifier: BUSL-1.1
"use client";

import { BriefcaseBusiness, MoreHorizontal } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "../../lib/cn";
import { Button } from "../button";
import { InboxMessageHandlingIconTile } from "./icons";
import {
  type InboxMessageHandlingCaseCategoriesProps,
  type InboxMessageHandlingChoice,
  type InboxMessageHandlingRowHeaderProps,
} from "./types";
import { defaultChoices } from "./defaults";

export function InboxMessageHandlingPanelHeader({
  title,
  className,
}: {
  title: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="inbox-message-handling-row-panelheader"
      className={cn(
        "flex h-12 w-full shrink-0 items-center border-b border-[var(--color-border-subtle)] px-4",
        className,
      )}
    >
      <p className="font-sans text-[13px] font-semibold leading-[13px] tracking-[-0.39px] text-[var(--color-foreground-subtle)]">
        {title}
      </p>
    </div>
  );
}

export function InboxMessageHandlingRowHeader({
  icon,
  category = "case",
  title,
  subtitle,
  className,
  ...props
}: InboxMessageHandlingRowHeaderProps) {
  return (
    <div
      {...props}
      data-slot="inbox-message-handling-row-header"
      className={cn(
        "flex w-full shrink-0 items-center gap-[10px] px-4",
        className,
      )}
    >
      <InboxMessageHandlingIconTile
        tone="panel-header"
        icon={icon ?? <BriefcaseBusiness className="size-4" />}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 className="truncate font-sans text-[20px] font-medium leading-5 tracking-[-0.6px] text-[var(--color-foreground-subtle)]">
          {title}
        </h2>
        <p className="truncate font-sans text-[12px] font-normal leading-3 tracking-[-0.36px] text-[var(--color-foreground-subtle)]">
          {subtitle}
        </p>
      </div>
    </div>
  );
}

export function InboxMessageHandlingCaseCategories({
  choices = defaultChoices,
  selectedChoice,
  onChoiceChange,
  startCaseLabel = "Start zaak",
  startCaseShortcut,
  startCaseDisabled,
  startCaseStatus,
  onStartCase,
  className,
  ...props
}: InboxMessageHandlingCaseCategoriesProps) {
  const [uncontrolledChoice, setUncontrolledChoice] = useState<string | undefined>(
    selectedChoice,
  );
  const resolvedSelectedChoice = selectedChoice ?? uncontrolledChoice;

  return (
    <div
      {...props}
      data-slot="inbox-message-handling-row-case-categories"
      className={cn(
        "flex h-[344px] w-full shrink-0 flex-col items-end gap-6 px-4 pt-10",
        className,
      )}
    >
      <div role="radiogroup" className="flex w-full flex-col gap-2">
        {choices.map((choice) => (
          <InboxMessageHandlingChoiceRow
            key={choice.value}
            choice={choice}
            checked={choice.value === resolvedSelectedChoice}
            onSelect={() => {
              setUncontrolledChoice(choice.value);
              onChoiceChange?.(choice.value);
            }}
          />
        ))}
      </div>
      <Button
        type="button"
        variant="primary"
        size="default"
        disabled={startCaseDisabled}
        onClick={() => onStartCase?.(resolvedSelectedChoice)}
        className="h-8 px-2"
      >
        {startCaseLabel}
        {startCaseShortcut ? (
          <span className="font-normal">{startCaseShortcut}</span>
        ) : null}
      </Button>
      {startCaseStatus ? (
        <p className="w-full text-right font-sans text-[12px] font-normal leading-4 tracking-[-0.36px] text-[var(--color-foreground-muted)]">
          {startCaseStatus}
        </p>
      ) : null}
    </div>
  );
}

function InboxMessageHandlingChoiceRow({
  choice,
  checked,
  onSelect,
}: {
  choice: InboxMessageHandlingChoice;
  checked: boolean;
  onSelect?: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      data-slot="inbox-message-handling-choice"
      className={cn(
        "group flex h-14 w-full items-center gap-2 rounded-[var(--radius-small)] border py-3 pl-3 pr-6 text-left transition-colors",
        checked
          ? "border-[var(--color-brand-amethyst-20)] bg-[#fbf8fd]"
          : "border-[var(--color-border-subtle)] bg-[var(--color-card)] hover:border-[var(--color-brand-amethyst-20)] hover:bg-[#fbf8fd]",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-full border",
          checked
            ? "border-[var(--color-border)]"
            : "border-[var(--color-border)]",
        )}
      >
        {checked ? (
          <span className="size-3 rounded-full bg-[var(--color-foreground-subtle)]" />
        ) : null}
      </span>
      <InboxMessageHandlingIconTile
        tone={checked ? "selected" : "inactive"}
        icon={choice.icon ?? <MoreHorizontal />}
      />
      <span className="flex min-w-0 flex-col gap-[6px] pt-px">
        <span className="truncate font-sans text-[13px] font-medium leading-[13px] tracking-[-0.39px] text-[var(--color-foreground-subtle)]">
          {choice.label}
        </span>
        {choice.description ? (
          <span
            className={cn(
              "truncate font-sans text-[12px] font-normal leading-3 tracking-[-0.36px]",
              checked
                ? "text-[#667084]"
                : "text-[var(--color-foreground-muted)]",
            )}
          >
            {choice.description}
          </span>
        ) : null}
      </span>
    </button>
  );
}
