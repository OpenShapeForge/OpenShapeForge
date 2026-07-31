// SPDX-License-Identifier: BUSL-1.1
"use client";

import { SidebarNav } from "@/components/ui/navigation/SidebarNav";
import { useAppShell } from "@/components/ui/layout/app-shell-context";

export function AppSidebarNav({
  expanded,
  onToggle,
  onNavigate,
  className,
}: {
  expanded: boolean;
  onToggle: () => void;
  onNavigate?: () => void;
  className?: string;
}) {
  const shell = useAppShell();

  return (
    <SidebarNav
      items={shell.items}
      settingsPanelGroups={shell.settingsPanelGroups}
      expanded={expanded}
      onToggle={onToggle}
      onNavigate={onNavigate}
      user={shell.user}
      activeLang={shell.activeLang}
      organization={shell.organization}
      className={className}
    />
  );
}
