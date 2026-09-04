// SPDX-License-Identifier: BUSL-1.1
"use client";

import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../lib/cn";

export type CaseCheckState = "pending" | "active" | "in-progress" | "checked";

export interface CaseCheckProps extends HTMLAttributes<HTMLDivElement> {
  /** Figma `state` axis. */
  state?: CaseCheckState;
  /** Figma `label` visibility/content axis. */
  label?: ReactNode;
  /** Figma `description` visibility/content axis. */
  description?: ReactNode;
}

function ActiveIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className="size-5 shrink-0"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M11.6922 5.80781C11.7503 5.86586 11.7964 5.93479 11.8279 6.01066C11.8593 6.08654 11.8755 6.16787 11.8755 6.25C11.8755 6.33213 11.8593 6.41346 11.8279 6.48934C11.7964 6.56521 11.7503 6.63414 11.6922 6.69219L7.31719 11.0672C7.25915 11.1253 7.19022 11.1714 7.11434 11.2029C7.03847 11.2343 6.95714 11.2505 6.875 11.2505C6.79287 11.2505 6.71154 11.2343 6.63567 11.2029C6.55979 11.1714 6.49086 11.1253 6.43282 11.0672L4.55782 9.19219C4.44054 9.07491 4.37466 8.91585 4.37466 8.75C4.37466 8.58415 4.44054 8.42509 4.55782 8.30781C4.67509 8.19054 4.83415 8.12465 5 8.12465C5.16586 8.12465 5.32492 8.19054 5.44219 8.30781L6.875 9.74141L10.8078 5.80781C10.8659 5.7497 10.9348 5.7036 11.0107 5.67215C11.0865 5.6407 11.1679 5.62451 11.25 5.62451C11.3321 5.62451 11.4135 5.6407 11.4893 5.67215C11.5652 5.7036 11.6341 5.7497 11.6922 5.80781ZM16.25 8.125C16.25 9.73197 15.7735 11.3029 14.8807 12.639C13.9879 13.9752 12.719 15.0166 11.2343 15.6315C9.74966 16.2465 8.11599 16.4074 6.5399 16.0939C4.9638 15.7804 3.51606 15.0065 2.37976 13.8702C1.24346 12.7339 0.469628 11.2862 0.156123 9.71011C-0.157382 8.13401 0.00352044 6.50035 0.618482 5.0157C1.23344 3.53105 2.27485 2.2621 3.611 1.36931C4.94714 0.476523 6.51803 8.32667e-16 8.125 0C10.2792 0.00227486 12.3445 0.85903 13.8677 2.38227C15.391 3.90551 16.2477 5.97081 16.25 8.125ZM15 8.125C15 6.76525 14.5968 5.43604 13.8414 4.30545C13.0859 3.17487 12.0122 2.29368 10.756 1.77333C9.49971 1.25298 8.11738 1.11683 6.78376 1.3821C5.45014 1.64737 4.22513 2.30216 3.26364 3.26364C2.30216 4.22513 1.64738 5.45013 1.3821 6.78375C1.11683 8.11737 1.25298 9.49971 1.77333 10.7559C2.29368 12.0122 3.17487 13.0859 4.30546 13.8414C5.43605 14.5968 6.76526 15 8.125 15C9.94773 14.9979 11.6952 14.2729 12.9841 12.9841C14.2729 11.6952 14.9979 9.94773 15 8.125Z"
        fill="var(--color-foreground-muted)"
        transform="translate(1.875 1.875)"
      />
    </svg>
  );
}

function PendingIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className="size-5 shrink-0"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle
        cx="10"
        cy="10"
        r="7.5"
        stroke="var(--color-foreground-muted)"
        strokeWidth="1.25"
      />
    </svg>
  );
}

function InProgressIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className="size-5 shrink-0"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="10" cy="10" r="8" fill="var(--color-brand-indigo-100)" />
      <path
        d="M10 2a8 8 0 0 1 0 16Z"
        fill="var(--color-brand-indigo-40)"
      />
      <circle
        cx="10"
        cy="10"
        r="7.5"
        stroke="var(--color-brand-indigo-100)"
      />
    </svg>
  );
}

function CheckedIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className="size-5 shrink-0"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="10" cy="10" r="8" fill="var(--color-brand-aquamarine-80)" />
      <path
        d="m6.75 10.15 2.15 2.15 4.65-4.65"
        stroke="var(--color-white)"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

/**
 * `case-check` component for compact case-step status rows.
 *
 * @figma case-check component-id=1001:14253 file-key=CbKdajB2p4lAW3bBGcHBYd node-id=226-59907
 * @figma node-id=311-6178 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=311-6178
 * @figma node-id=311-6179 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=311-6179
 * @figma node-id=311-6184 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=311-6184
 * @figma node-id=311-6244 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=311-6244
 */
export function CaseCheck({
  state = "active",
  label = "Checkbox Text",
  description,
  className,
  ...props
}: CaseCheckProps) {
  const isChecked = state === "checked";
  const isInProgress = state === "in-progress";
  const isPending = state === "pending";

  return (
    <div
      data-slot="case-check"
      data-state={state}
      className={cn(
        "flex min-h-5 w-full max-w-[184px] items-start gap-1 font-sans",
        className,
      )}
      {...props}
    >
      {isChecked ? (
        <CheckedIcon />
      ) : isInProgress ? (
        <InProgressIcon />
      ) : isPending ? (
        <PendingIcon />
      ) : (
        <ActiveIcon />
      )}
      <div className="flex min-w-0 flex-col gap-2 pt-1">
        {label ? (
          <span className="text-[12px] leading-3 tracking-[-0.36px] text-[var(--color-foreground-subtle)]">
            {label}
          </span>
        ) : null}
        {description ? (
          <span className="text-[12px] leading-3 tracking-[-0.36px] text-[var(--color-foreground-muted)]">
            {description}
          </span>
        ) : null}
      </div>
    </div>
  );
}
