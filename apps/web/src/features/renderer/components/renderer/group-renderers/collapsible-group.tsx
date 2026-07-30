// SPDX-License-Identifier: BUSL-1.1
import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export function CollapsibleGroup({
  title,
  defaultExpanded,
  children,
}: {
  title: string;
  defaultExpanded: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="text-foreground flex w-full min-w-0 items-center gap-2 rounded py-1 text-left text-[13px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown
          className={cn(
            "text-muted-foreground size-4 shrink-0 transition-transform",
            !expanded && "-rotate-90",
          )}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </button>
      {expanded ? <div className="mt-3">{children}</div> : null}
    </div>
  );
}
