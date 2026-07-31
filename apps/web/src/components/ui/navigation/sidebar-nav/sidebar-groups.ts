// SPDX-License-Identifier: BUSL-1.1
import { Circle, Search } from "lucide-react";
import type { SidebarGroup, SidebarNavItem } from "@openshapeforge/ui";
import { resolveLucideIconByName } from "@/components/ui/icons/LucideIconByName";
import type { SidebarEntry } from "@/lib/navigation/types";
import { isRouteActive } from "./route-active";

export function toSidebarGroups(
  entries: SidebarEntry[],
  pathname: string,
  onNavigate?: () => void,
): SidebarGroup[] {
  const groups: SidebarGroup[] = [
    {
      id: "search",
      items: [{ id: "search", label: "Zoeken", icon: Search }],
    },
  ];

  let currentGroup: SidebarGroup = { id: "group-1", items: [] };
  groups.push(currentGroup);
  for (const entry of entries) {
    if (entry.type === "separator") {
      currentGroup = { id: `group-${groups.length}`, items: [] };
      groups.push(currentGroup);
      continue;
    }

    if (entry.type === "category") {
      currentGroup.label = entry.label;
      continue;
    }

    const Icon = resolveLucideIconByName(entry.icon) ?? Circle;
    const navItem: SidebarNavItem = {
      id: entry.key,
      label: entry.label,
      icon: Icon,
      href: entry.type === "item" ? entry.href : undefined,
      current: entry.type === "item" ? isRouteActive(entry.href, pathname) : false,
      onClick: onNavigate,
      disabled: entry.type === "stub",
    };

    currentGroup.items.push(navItem);
  }

  return groups.filter((group) => group.items.length > 0);
}
