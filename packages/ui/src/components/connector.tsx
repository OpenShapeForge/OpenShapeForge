// SPDX-License-Identifier: BUSL-1.1
"use client";

import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

export type ConnectorVariant = "straight" | "right" | "left";
export type ConnectorState = "active" | "hover";

/**
 * Battery connector path used for workflow diagrams.
 *
 * @figma connector — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=15-5406
 * @figma variant=straight,state=active — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=15-5400
 * @figma variant=straight,state=hover — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=15-5421
 * @figma variant=right,state=active — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=15-5407
 * @figma variant=right,state=hover — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=15-5426
 * @figma variant=left,state=active — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=15-5417
 * @figma variant=left,state=hover — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=15-5431
 */
export interface ConnectorProps extends HTMLAttributes<HTMLDivElement> {
  /** Figma connector direction. */
  variant?: ConnectorVariant;
  /** Figma visual state. */
  state?: ConnectorState;
  /** Optional label shown on hover variants. */
  label?: ReactNode;
}

const connectorColor = {
  active: "bg-muted-foreground/50 border-muted-foreground/50",
  hover: "bg-foreground border-foreground",
} satisfies Record<ConnectorState, string>;

function Endpoint({ state, className }: { state: ConnectorState; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute size-[3px] rounded-full",
        state === "hover" ? "bg-foreground" : "bg-muted-foreground/50",
        className,
      )}
    />
  );
}

function ConnectorLabel({ children }: { children: ReactNode }) {
  return (
    <span className="-translate-x-1/2 -translate-y-1/2 absolute left-1/2 top-1/2 rounded-[var(--radius-extrasmall)] bg-foreground px-1 py-0.5 font-sans text-[9px] font-normal leading-[10px] tracking-[-0.27px] text-card">
      {children}
    </span>
  );
}

export function Connector({
  variant = "straight",
  state = "active",
  label,
  className,
  ...props
}: ConnectorProps) {
  const color = connectorColor[state];

  return (
    <div
      data-variant={variant}
      data-state={state}
      className={cn("relative size-20", className)}
      {...props}
    >
      {variant === "straight" ? (
        <>
          <span
            aria-hidden="true"
            className={cn(
              "-translate-x-1/2 absolute left-1/2 top-px h-[78px] w-px",
              state === "hover" ? "bg-foreground" : "bg-muted-foreground/50",
            )}
          />
          <Endpoint state={state} className="-translate-x-1/2 left-1/2 top-0" />
          <Endpoint state={state} className="-translate-x-1/2 bottom-0 left-1/2" />
        </>
      ) : (
        <>
          <span
            aria-hidden="true"
            className={cn(
              "absolute top-px h-[39px] w-[39px] border-b border-solid",
              variant === "right"
                ? "left-1/2 rounded-bl-[var(--radius-small)] border-l"
                : "right-1/2 rounded-br-[var(--radius-small)] border-r",
              color,
            )}
          />
          <span
            aria-hidden="true"
            className={cn(
              "absolute top-[39px] h-[40px] w-px",
              variant === "right" ? "right-px" : "left-px",
              state === "hover" ? "bg-foreground" : "bg-muted-foreground/50",
            )}
          />
          <Endpoint
            state={state}
            className={variant === "right" ? "left-1/2 top-0" : "right-1/2 top-0"}
          />
          <Endpoint
            state={state}
            className={variant === "right" ? "bottom-0 right-0" : "bottom-0 left-0"}
          />
          {state === "hover" && label ? <ConnectorLabel>{label}</ConnectorLabel> : null}
        </>
      )}
    </div>
  );
}

/**
 * Self-positioning decorative connector dot for node-card handle positions.
 * The actual React Flow handle can be slotted by consumers when interaction is needed.
 */
export interface ConnectorDotProps {
  /** Position relative to the containing node card. */
  at: "top" | "bottom" | "left" | "right";
  className?: string;
  style?: CSSProperties;
}

export function ConnectorDot({ at, className, style }: ConnectorDotProps) {
  const placement = {
    top: "absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2",
    bottom: "absolute left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2",
    left: "absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2",
    right: "absolute right-0 top-1/2 translate-x-1/2 -translate-y-1/2",
  }[at];

  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none block size-[7px] rounded-full border border-node-card-border bg-card",
        placement,
        className,
      )}
      style={style}
    />
  );
}
