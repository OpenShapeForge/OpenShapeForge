// SPDX-License-Identifier: BUSL-1.1
"use client";

import type { ReactNode } from "react";

import { cn } from "../../lib/cn";

export function InboxMessageHandlingIconTile({
  icon,
  tone = "inactive",
}: {
  icon: ReactNode;
  tone?: "panel-header" | "selected" | "inactive";
}) {
  return (
    <span
      data-slot="inbox-message-handling-icon-tile"
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-[4px] [&_svg]:size-4",
        tone === "panel-header" &&
          "bg-[#8899a3] text-[var(--color-white)]",
        tone === "selected" &&
          "bg-[#a47ad1] text-[var(--color-white)]",
        tone === "inactive" &&
          "border border-[var(--color-border-subtle)] bg-[var(--color-card)] text-[var(--color-foreground-muted)] group-hover:border-transparent group-hover:bg-[#a47ad1] group-hover:text-[var(--color-white)]",
      )}
    >
      {icon}
    </span>
  );
}

export function BoxingGloveIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
      <path
        d="M6.2 2.2c2.55-.85 5.4.7 6.15 3.25.38 1.26.12 2.52-.55 3.55-.78 1.18-1.94 1.84-3.34 2.03l-.34 1.42c-.16.68-.76 1.15-1.46 1.15H4.8c-.83 0-1.5-.67-1.5-1.5V9.7c-.82-.6-1.23-1.42-1.23-2.45 0-1.13.5-2.03 1.45-2.7.54-.38 1.18-.6 1.9-.66.08-.74.34-1.3.78-1.69Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.25"
      />
      <path
        d="M5.38 3.9v3.25m2.06-3.58v3.38m2.02-2.74v2.58M3.3 9.7h4.82"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.25"
      />
    </svg>
  );
}

export function ScrewdriverIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
      <path
        d="m10.65 2.15 3.2 3.2-1.7 1.7-1.3-.42-5.93 5.93a1.45 1.45 0 0 1-2.05-2.05l5.93-5.93-.42-1.3 2.27-1.13Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.25"
      />
      <path
        d="m8.8 4.58 2.62 2.62M3.92 11.08l1 1"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.25"
      />
    </svg>
  );
}
