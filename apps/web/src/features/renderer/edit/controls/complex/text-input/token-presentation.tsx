// SPDX-License-Identifier: BUSL-1.1
"use client";

import { X } from "lucide-react";
import type { CSSProperties, RefObject } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@openshapeforge/ui";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import { setSelectionOffsets } from "./editor-selection";
import type { TokenSegment } from "./types";

function renderTooltipContent(
  path: string,
  suggestion: VariableSuggestion | null,
) {
  if (!suggestion) {
    return (
      <div className="space-y-1">
        <p className="font-medium">{path}</p>
        <p className="text-[11px] opacity-80">Variabele bron niet gevonden.</p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <p className="font-medium">{suggestion.label}</p>
      <p className="text-[11px] opacity-80">Node: {suggestion.sourceNodeLabel}</p>
      <p className="text-[11px] opacity-80">{suggestion.displayPath}</p>
    </div>
  );
}

function getTokenStyle(suggestion: VariableSuggestion | null): CSSProperties {
  const tone = suggestion?.sourceNodeTone;
  if (!tone) {
    return {
      backgroundColor: "color-mix(in srgb, var(--color-primary) 10%, transparent)",
      borderColor: "color-mix(in srgb, var(--color-primary) 22%, var(--color-border))",
      color: "color-mix(in srgb, var(--color-primary) 82%, var(--color-foreground))",
    };
  }

  return {
    backgroundColor: tone.background,
    borderColor: tone.border,
    color: tone.text,
  };
}

function getTokenRemoveOverlayStyle(
  suggestion: VariableSuggestion | null,
): CSSProperties | undefined {
  const background = suggestion?.sourceNodeTone?.background;
  if (!background) {
    return undefined;
  }

  return {
    backgroundImage: `linear-gradient(90deg, transparent 0%, ${background} 38%, ${background} 100%)`,
  };
}

export function TokenDisplayChip({
  display,
  path,
  title,
  suggestion,
}: {
  display: string;
  path: string;
  title: string;
  suggestion: VariableSuggestion | null;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex max-w-full items-center rounded-full border px-2.5 py-1 align-middle text-xs font-medium"
          style={getTokenStyle(suggestion)}
          title={title}
        >
          <span className="whitespace-normal break-words leading-tight">
            {display}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" align="start">
        {renderTooltipContent(path, suggestion)}
      </TooltipContent>
    </Tooltip>
  );
}

export function TokenizedSegmentList({
  segments,
  disabled,
  readOnly,
  rootRef,
  onRemoveRange,
}: {
  segments: TokenSegment[];
  disabled?: boolean;
  readOnly?: boolean;
  rootRef: RefObject<HTMLDivElement | null>;
  onRemoveRange: (start: number, end: number) => void;
}) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === "token" ? (
          <span key={`${segment.raw}-${index}`}>
            <span
              aria-hidden="true"
              className="inline-block min-w-[0.25rem] align-middle whitespace-pre"
              data-caret-anchor="true"
              data-caret-anchor-position="before"
            >
              {"\u00a0"}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="group relative inline-flex max-w-full items-center rounded-full border px-2.5 py-1 align-middle text-xs font-medium"
                  contentEditable={false}
                  data-token-insert={segment.raw}
                  style={getTokenStyle(segment.suggestion)}
                  title={segment.title}
                  onMouseDown={(event) => {
                    if ((event.target as HTMLElement).closest("button")) {
                      return;
                    }
                    event.preventDefault();
                    const root = rootRef.current;
                    if (!root) {
                      return;
                    }
                    root.focus();
                    setSelectionOffsets(root, {
                      start: segment.end,
                      end: segment.end,
                    });
                  }}
                >
                  <span className="whitespace-normal break-words leading-tight">
                    {segment.display}
                  </span>
                  {!disabled && !readOnly ? (
                    <span
                      className="pointer-events-none absolute inset-y-0 right-0 flex items-center rounded-r-full pl-5 pr-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                      style={getTokenRemoveOverlayStyle(segment.suggestion)}
                    >
                      <button
                        type="button"
                        aria-label={`Verwijder ${segment.display}`}
                        className="pointer-events-auto inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-black/5 transition hover:bg-black/10"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => onRemoveRange(segment.start, segment.end)}
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ) : null}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" align="start">
                {renderTooltipContent(segment.path, segment.suggestion)}
              </TooltipContent>
            </Tooltip>
            <span
              aria-hidden="true"
              className="inline-block min-w-[0.25rem] align-middle whitespace-pre"
              data-caret-anchor="true"
              data-caret-anchor-position="after"
            >
              {"\u00a0"}
            </span>
          </span>
        ) : (
          <span key={`text-${index}`}>{segment.text}</span>
        ),
      )}
    </>
  );
}
