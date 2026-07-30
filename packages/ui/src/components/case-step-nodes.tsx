// SPDX-License-Identifier: BUSL-1.1
"use client";

import { cn } from "../lib/cn";

export type CaseStepNodeStep =
  | "origin"
  | "message"
  | "checked"
  | "step"
  | "error"
  | "progress"
  | "line"
  | "end";

export interface CaseStepNodesProps {
  /** Figma `step` variant. */
  step?: CaseStepNodeStep;
  /** Whether to render the connector segment above the glyph. */
  top?: boolean;
  /** Whether to render the connector segment below the glyph. */
  bottom?: boolean;
  /** Figma uses a dotted connector under the origin selector row. */
  dashed?: boolean;
  className?: string;
}

function Segment({
  className,
  dashed = false,
}: {
  className?: string;
  dashed?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "block w-px",
        dashed
          ? "bg-[linear-gradient(to_bottom,var(--color-border)_50%,transparent_50%)] bg-[length:1px_4px]"
          : "bg-border",
        className,
      )}
    />
  );
}

function StepGlyph({ step }: { step: Exclude<CaseStepNodeStep, "line"> }) {
  if (step === "origin") {
    return (
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="size-4 text-foreground-muted"
        fill="currentColor"
      >
        <path d="M3.75 3.25h8.5v1.5h-8.5z" />
        <path d="M5.25 5.75h5.5v3.1h2.05L8 13.65 3.2 8.85h2.05z" />
      </svg>
    );
  }
  if (step === "message") {
    return (
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="size-4 text-foreground-muted"
      >
        <rect
          x="2.25"
          y="3.75"
          width="11.5"
          height="8.5"
          rx="1.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.25"
        />
        <path
          d="m3.25 5 4.75 3.5L12.75 5"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.25"
        />
      </svg>
    );
  }
  if (step === "checked") {
    return (
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="size-4"
      >
        <circle cx="8" cy="8" r="7.5" fill="var(--color-brand-aquamarine-80)" />
        <path
          d="m5.1 8.15 1.75 1.75 4.05-4.05"
          fill="none"
          stroke="white"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
        />
      </svg>
    );
  }
  if (step === "progress") {
    return (
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="size-4"
      >
        <circle cx="8" cy="8" r="7.5" fill="var(--color-brand-indigo-100)" />
        <path
          d="m5.25 5.75 2.75 2.75 2.75-2.75M5.25 8.5 8 11.25 10.75 8.5"
          fill="none"
          stroke="white"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.25"
        />
      </svg>
    );
  }
  if (step === "error") {
    return (
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="size-4"
      >
        <circle cx="8" cy="8" r="7.5" fill="var(--color-functional-red-80)" />
        <path
          d="m5.75 5.75 4.5 4.5M10.25 5.75l-4.5 4.5"
          fill="none"
          stroke="white"
          strokeLinecap="round"
          strokeWidth="1.5"
        />
      </svg>
    );
  }
  if (step === "end") {
    return (
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="size-4"
      >
        <circle cx="8" cy="8" r="7.5" fill="var(--color-brand-platinum-100)" />
        <rect x="5.75" y="5.75" width="4.5" height="4.5" rx="1" fill="white" />
      </svg>
    );
  }

  return (
    <span
      aria-hidden="true"
      className="block size-3 rounded-full border border-border bg-card"
    />
  );
}

/**
 * Habeon 1.3 `case-step-nodes` — vertical case workflow rail node.
 *
 * @figma case-step-nodes — https://www.figma.com/design/CbKdajB2p4lAW3bBGcHBYd/Habe%C5%8Dn-1.3?node-id=227-60997
 */
export function CaseStepNodes({
  step = "origin",
  top = true,
  bottom = true,
  dashed = false,
  className,
}: CaseStepNodesProps) {
  if (step === "line") {
    return (
      <span
        data-step={step}
        className={cn("flex h-[16px] w-4 shrink-0 flex-col items-center", className)}
      >
        {top ? <Segment dashed={dashed} className="h-[5px]" /> : null}
        <Segment dashed={dashed} className="min-h-px flex-1" />
        {bottom ? <Segment dashed={dashed} className="h-[5px]" /> : null}
      </span>
    );
  }

  return (
    <span
      data-step={step}
      className={cn("relative flex h-[22px] w-4 shrink-0 items-center justify-center", className)}
    >
      {top ? (
        <Segment
          dashed={dashed}
          className="absolute left-1/2 top-0 h-[5px] -translate-x-1/2"
        />
      ) : null}
      <span className="relative z-[1] flex size-4 items-center justify-center bg-card">
        <StepGlyph step={step} />
      </span>
      {bottom ? (
        <Segment
          dashed={dashed}
          className="absolute bottom-0 left-1/2 h-[5px] -translate-x-1/2"
        />
      ) : null}
    </span>
  );
}
