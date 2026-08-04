// SPDX-License-Identifier: BUSL-1.1
"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { RuntimeBadges } from "./runtime-badges";
import type { NodeRuntime, NodeState, NodeType } from "./types";

/**
 * The text column of a node card: what this node is called, what kind of node
 * it is, and how it is doing.
 *
 * A palette row is quieter than a canvas card and gains weight on hover; a
 * canvas card is always semibold, because on a canvas the name is the only
 * thing carrying the node.
 */
export function TypePair({
  title,
  subtitle,
  type,
  state,
  runtime,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  type: NodeType;
  state: NodeState;
  runtime?: NodeRuntime | null;
}) {
  const isLibrary = type === "library";

  const titleWeight = isLibrary
    ? state === "hover"
      ? "font-semibold"
      : "font-medium group-hover:font-semibold"
    : "font-semibold";

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <p
        className={cn(
          "min-w-0 truncate font-sans tracking-[-0.03em]",
          isLibrary
            ? "text-[12px] leading-[12px] text-foreground-subtle"
            : "text-[13px] leading-[13px] text-foreground",
          titleWeight,
        )}
      >
        {title}
      </p>
      {subtitle ? (
        <p className="min-w-0 truncate font-sans text-[12px] leading-[12px] tracking-[-0.03em] text-muted-foreground">
          {subtitle}
        </p>
      ) : null}
      {runtime ? <RuntimeBadges runtime={runtime} /> : null}
    </div>
  );
}
