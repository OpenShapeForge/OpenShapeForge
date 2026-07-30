// SPDX-License-Identifier: BUSL-1.1
"use client";

import { ChevronDown } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

import { Field as FieldFrame } from "@/features/renderer/components/field";
import {
  HelpAffordance,
  ScreenReaderDescription,
} from "@/features/renderer/components/field/label";
import { cn } from "@/lib/utils";

type ObjectFieldProps = {
  id?: string;
  label: string;
  description?: string;
  helpText?: string;
  lang?: "nl" | "en";
  className?: string;
  bodyClassName?: string;
  /**
   * Initial expanded state at mount. After mount the user controls it.
   * Callers compute this from the child count under the renderer's
   * progressive-disclosure rule (1–4 children → open, 5+ → closed).
   */
  initialExpanded?: boolean;
  children: ReactNode;
};

export function ObjectField({
  id,
  label,
  description,
  helpText,
  lang = "nl",
  className,
  bodyClassName,
  initialExpanded = false,
  children,
}: ObjectFieldProps) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const reactId = useId();
  const sectionId = id ?? `object-${reactId}`;
  const headerId = `${sectionId}-header`;
  const bodyId = `${sectionId}-body`;

  return (
    <FieldFrame
      id={sectionId}
      label={null}
      lang={lang}
      className={className}
    >
      {(controlProps) => (
        <div id={controlProps.id} tabIndex={-1} className="w-full">
          <div className="flex items-center gap-2">
            <button
              type="button"
              id={headerId}
              onClick={() => setExpanded((prev) => !prev)}
              aria-expanded={expanded}
              aria-controls={bodyId}
              className="text-foreground flex min-w-0 flex-1 items-center gap-2 rounded py-1 text-left text-[13px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronDown
                className={cn(
                  "text-muted-foreground size-4 shrink-0 transition-transform",
                  !expanded && "-rotate-90",
                )}
                aria-hidden="true"
              />
              <span className="min-w-0 truncate">{label}</span>
            </button>
            <HelpAffordance
              description={description}
              helpText={helpText}
              fieldLabel={label}
              lang={lang}
            />
            <ScreenReaderDescription description={description} />
          </div>
          {expanded ? (
            <div id={bodyId} className={bodyClassName}>
              {children}
            </div>
          ) : null}
        </div>
      )}
    </FieldFrame>
  );
}
