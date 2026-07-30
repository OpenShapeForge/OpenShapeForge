// SPDX-License-Identifier: BUSL-1.1
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SettingsPanelGroup } from "@/lib/navigation/types";
import { isRouteActive } from "./route-active";

export function SettingsPanel({
  expanded,
  onClose,
  onNavigate,
  groups,
}: {
  expanded: boolean;
  onClose: () => void;
  onNavigate?: () => void;
  groups: SettingsPanelGroup[];
}) {
  const pathname = usePathname() ?? "/";

  return (
    <div
      className={cn(
        "absolute z-50 max-h-[min(80vh,720px)] overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-lg",
        expanded ? "bottom-12 left-0 right-0 mb-1" : "bottom-12 left-full ml-2 w-60",
      )}
    >
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Configuratie
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Sluiten"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="p-2">
        {groups.map((group) => (
          <div key={group.label} className="mb-3 last:mb-0">
            <p className="px-2 pb-1 pt-1 text-[9px] font-normal uppercase tracking-wide text-muted-foreground">
              {group.label}
            </p>
            {group.items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => {
                  onClose();
                  onNavigate?.();
                }}
                className={cn(
                  "flex items-center rounded-sm px-2 py-1.5 text-sm",
                  isRouteActive(item.href, pathname)
                    ? "bg-muted-foreground text-white"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground-subtle",
                )}
              >
                {item.label}
              </Link>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
