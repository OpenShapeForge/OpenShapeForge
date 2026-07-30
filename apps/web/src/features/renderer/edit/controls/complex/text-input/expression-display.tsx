// SPDX-License-Identifier: BUSL-1.1
"use client";

import { TooltipProvider } from "@openshapeforge/ui";
import { TokenDisplayChip } from "./token-presentation";
import {
  parseSegments,
  tokenNeedsLeadingSpacer,
  tokenNeedsTrailingSpacer,
} from "./tokens";
import type { TextInputExpressionDisplayProps } from "./types";

export function TextInputExpressionDisplay({
  value,
  suggestions = [],
  className,
  emptyState = null,
}: TextInputExpressionDisplayProps) {
  if (!value) {
    return <>{emptyState}</>;
  }

  const segments = parseSegments(value, suggestions);

  return (
    <TooltipProvider delayDuration={100}>
      <span className={className}>
        {segments.map((segment, index) =>
          segment.kind === "token" ? (
            <span key={`${segment.raw}-${index}`}>
              {tokenNeedsLeadingSpacer(segments, index) ? (
                <span aria-hidden="true"> </span>
              ) : null}
              <TokenDisplayChip
                display={segment.display}
                path={segment.path}
                suggestion={segment.suggestion}
                title={segment.title}
              />
              {tokenNeedsTrailingSpacer(segments, index) ? (
                <span aria-hidden="true"> </span>
              ) : null}
            </span>
          ) : (
            <span key={`text-${index}`}>{segment.text}</span>
          ),
        )}
      </span>
    </TooltipProvider>
  );
}
