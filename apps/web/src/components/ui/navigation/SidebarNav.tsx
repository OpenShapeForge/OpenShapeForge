// SPDX-License-Identifier: BUSL-1.1
"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SlidersHorizontal } from "lucide-react";
import { Sidebar } from "@openshapeforge/ui";
import { UserProfileMenu } from "@/components/ui/navigation/UserProfileMenu";
import { SettingsPanel } from "@/components/ui/navigation/sidebar-nav/SettingsPanel";
import { resolveOrganizationAvatar } from "@/components/ui/navigation/sidebar-nav/organization-avatar";
import {
  DEFAULT_SETTINGS_PANEL_GROUPS,
  mergeSettingsPanelGroups,
} from "@/components/ui/navigation/sidebar-nav/settings-panel-groups";
import { toSidebarGroups } from "@/components/ui/navigation/sidebar-nav/sidebar-groups";
import { cn } from "@/lib/utils";
import type { SettingsPanelGroup, SidebarEntry } from "@/lib/navigation/types";

export type { SidebarEntry };

export interface SidebarNavProps {
  items: SidebarEntry[];
  settingsPanelGroups?: SettingsPanelGroup[];
  expanded: boolean;
  onToggle: () => void;
  onNavigate?: () => void;
  user?: { name: string; role?: string };
  activeLang?: "en" | "nl";
  organization?: { name: string; avatarStorageLocation?: string | null };
  className?: string;
}

export function SidebarNav({
  items,
  settingsPanelGroups: additionalSettingsPanelGroups,
  expanded,
  onToggle,
  onNavigate,
  user,
  activeLang = "en",
  organization,
  className,
}: SidebarNavProps) {
  const pathname = usePathname() ?? "/";
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const settingsRef = React.useRef<HTMLDivElement>(null);
  const state = expanded ? "expanded" : "collapsed";

  React.useEffect(() => {
    if (!settingsOpen) return;
    function handleClick(e: MouseEvent) {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [settingsOpen]);

  const groups = React.useMemo(
    () => toSidebarGroups(items, pathname, onNavigate),
    [items, onNavigate, pathname],
  );
  const settingsPanelGroups = React.useMemo(
    () => mergeSettingsPanelGroups(DEFAULT_SETTINGS_PANEL_GROUPS, additionalSettingsPanelGroups),
    [additionalSettingsPanelGroups],
  );
  const personAvatar = user ? (
    <UserProfileMenu
      name={user.name}
      role={user.role}
      activeLang={activeLang}
    />
  ) : null;
  const { organizationName, organizationAvatar } = resolveOrganizationAvatar(organization);

  return (
    <div ref={settingsRef} className={cn("relative h-full", className)}>
      {settingsOpen ? (
        <SettingsPanel
          expanded={expanded}
          onClose={() => setSettingsOpen(false)}
          onNavigate={onNavigate}
          groups={settingsPanelGroups}
        />
      ) : null}
      <Sidebar
        state={state}
        groups={groups}
        linkComponent={Link}
        bottomAction={{
          id: "settings",
          label: "Instellingen",
          icon: SlidersHorizontal,
          current: settingsOpen,
          onClick: () => setSettingsOpen((open) => !open),
        }}
        personAvatar={personAvatar}
        personName={user?.name ?? ""}
        personRole={user?.role ?? ""}
        organizationAvatar={organizationAvatar}
        organizationName={organizationName}
        onToggle={onToggle}
        aria-label="Hoofdnavigatie"
      />
    </div>
  );
}
