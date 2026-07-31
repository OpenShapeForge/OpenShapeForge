// SPDX-License-Identifier: BUSL-1.1
import { GitMerge, TableProperties, X } from "lucide-react";

import { cn } from "../../lib/cn";
import type { BaseLayoutTab } from "./types";

export const defaultTabs: BaseLayoutTab[] = [
  { id: "tab-1", label: "Tab 1", current: true, closable: true },
  { id: "tab-2", label: "Tab 2" },
  { id: "tab-3", label: "Tab 3" },
  { id: "tab-4", label: "Tab 4" },
  { id: "tab-5", label: "Tab 4" },
];

function TabIcon() {
  return <GitMerge className="size-4 shrink-0" strokeWidth={1.5} />;
}

function TopTab({ tab }: { tab: BaseLayoutTab }) {
  const current = Boolean(tab.current);

  return (
    <button
      type="button"
      className={cn(
        "flex h-8 w-[92px] shrink-0 items-center gap-1 rounded-[var(--radius-large)] px-2 py-2 font-sans text-[12px] font-medium leading-[12px] tracking-[-0.36px]",
        current
          ? "border-b border-[var(--color-border-subtle)] bg-[var(--color-card)] text-[var(--color-foreground)]"
          : "bg-[var(--color-accent)] text-[#596273]",
      )}
    >
      {tab.icon ?? <TabIcon />}
      <span className="min-w-0 flex-1 truncate text-left">{tab.label}</span>
      {tab.closable ? (
        <X className="size-3 shrink-0" strokeWidth={1.5} />
      ) : null}
    </button>
  );
}

export function TabsRow({ tabs }: { tabs: BaseLayoutTab[] }) {
  return (
    <div className="flex h-8 w-full shrink-0 items-start gap-1">
      {tabs.map((tab) => (
        <TopTab key={tab.id} tab={tab} />
      ))}
      <div className="flex min-w-px flex-1 self-stretch justify-end">
        <button
          type="button"
          aria-label="Tabs"
          className="flex size-7 shrink-0 items-center justify-center text-[var(--color-foreground-muted)]"
        >
          <TableProperties className="size-4" strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}
