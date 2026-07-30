// SPDX-License-Identifier: BUSL-1.1
"use client";

import type { AnchorHTMLAttributes, ComponentType, ReactNode } from "react";
import {
  BookUser,
  Building2,
  GitFork,
  Inbox,
  Key,
  ListChecks,
  Search,
  Shovel,
  SlidersHorizontal,
  Smile,
  Vault,
  Wrench,
} from "lucide-react";

import { cn } from "../lib/cn";
import { Avatar } from "./avatar";
import { Seperator } from "./separator";
import { SidebarCategory } from "./sidebar-category";
import { SidebarItem } from "./sidebar-item";
import { SidebarLogo } from "./sidebar-logo";

type IconComponent = ComponentType<{ className?: string; strokeWidth?: string | number }>;
type LinkComponent = ComponentType<AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>;

export type SidebarNavItem = {
  id: string;
  icon: IconComponent;
  label: string;
  current?: boolean;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
};

export type SidebarGroup = {
  id: string;
  label?: string;
  items: SidebarNavItem[];
};

export type SidebarProps = {
  /** Figma `state` axis for `col-sidebar`. */
  state?: "collapsed" | "expanded";
  /** Navigation groups separated by Battery separators. */
  groups?: SidebarGroup[];
  /** Optional bottom action before the persona/organization avatars. */
  bottomAction?: SidebarNavItem | null;
  /** Person avatar rendered at the bottom of the rail. */
  personAvatar?: ReactNode;
  /** Person display name shown in the expanded footer row. */
  personName?: string;
  /** Person role shown in the expanded footer row. */
  personRole?: string;
  /** Organization avatar rendered at the bottom of the rail. */
  organizationAvatar?: ReactNode;
  /** Organization display name shown in the expanded footer row. */
  organizationName?: string;
  /** Called when the logo/sidebar control is pressed. */
  onToggle?: () => void;
  /** Optional app-router link implementation for client-side navigation. */
  linkComponent?: LinkComponent;
  /** Accessible label for the navigation landmark. */
  "aria-label"?: string;
  className?: string;
};

const defaultGroups: SidebarGroup[] = [
  {
    id: "search",
    items: [{ id: "search", label: "Zoeken", icon: Search }],
  },
  {
    id: "work",
    label: "Jouw werk",
    items: [
      { id: "inbox", label: "Inbox", icon: Inbox },
      { id: "work-queue", label: "Werkvoorraad", icon: ListChecks },
    ],
  },
  {
    id: "data",
    label: "Data",
    items: [
      { id: "relations", label: "Relaties", icon: BookUser },
      { id: "property", label: "Bezit", icon: Building2 },
      { id: "housing-allocation", label: "Woonruimteverdeling", icon: Key },
      { id: "maintenance", label: "Onderhoud", icon: Wrench },
      { id: "finance", label: "Financieel", icon: Vault },
      { id: "projects", label: "Projecten", icon: Shovel, current: true },
    ],
  },
  {
    id: "configuration",
    label: "Inrichting",
    items: [
      { id: "workflow-designer", label: "Workflow Designer", icon: GitFork },
      { id: "other", label: "Iets anders", icon: Smile },
    ],
  },
];

const defaultBottomAction: SidebarNavItem = {
  id: "settings",
  label: "Instellingen",
  icon: SlidersHorizontal,
};

function DefaultPersonAvatar() {
  return <Avatar variant="avatar-circle-image" src="https://i.pravatar.cc/64?img=13" alt="Albus Dumbledore" />;
}

function DefaultOrganizationAvatar() {
  return <Avatar variant="avatar-square-image" src="https://picsum.photos/seed/gryffindor/64/64" alt="Gryffindor" />;
}

function SidebarRule({ state }: { state: NonNullable<SidebarProps["state"]> }) {
  return (
    <div className={cn("flex h-px w-full shrink-0 flex-col", state === "expanded" ? "px-0" : "px-2")} aria-hidden>
      <Seperator variant="horizontal" />
    </div>
  );
}

function SidebarFooter({
  state,
  bottomAction,
  personAvatar,
  personName,
  personRole,
  organizationAvatar,
  organizationName,
  linkComponent,
}: Pick<
  SidebarProps,
  "bottomAction" | "linkComponent" | "organizationAvatar" | "organizationName" | "personAvatar" | "personName" | "personRole" | "state"
>) {
  const isExpanded = state === "expanded";
  const mode = state ?? "collapsed";
  const renderedPersonAvatar = personAvatar === undefined ? <DefaultPersonAvatar /> : personAvatar;
  const renderedOrganizationAvatar =
    organizationAvatar === undefined ? <DefaultOrganizationAvatar /> : organizationAvatar;

  return (
    <div className={cn("relative z-10 flex shrink-0 flex-col gap-2", isExpanded && "w-full")}>
      {bottomAction ? (
        <SidebarItem
          icon={bottomAction.icon}
          mode={mode}
          state={bottomAction.current ? "current" : "active"}
          href={bottomAction.href}
          linkComponent={linkComponent}
          onClick={bottomAction.onClick}
        >
          {bottomAction.label}
        </SidebarItem>
      ) : null}
      {isExpanded ? (
        <>
          {renderedPersonAvatar ? (
            <div className="flex w-full shrink-0 items-center gap-2">
              {renderedPersonAvatar}
              <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 overflow-hidden whitespace-nowrap font-sans font-normal">
                <p className="truncate text-[14px] leading-[14px] tracking-[-0.42px] text-[var(--color-foreground-subtle)]">
                  {personName}
                </p>
                <p className="truncate text-[12px] leading-[12px] tracking-[-0.36px] text-[var(--color-foreground-muted)]">
                  {personRole}
                </p>
              </div>
            </div>
          ) : null}
          {renderedOrganizationAvatar ? (
            <div className="flex w-full shrink-0 items-center gap-2 overflow-hidden">
              {renderedOrganizationAvatar}
              <div className="flex min-w-0 flex-1 items-center justify-between overflow-hidden">
                <p className="min-w-0 flex-1 truncate font-sans text-[14px] font-normal leading-[14px] tracking-[-0.42px] text-[var(--color-foreground)]">
                  {organizationName}
                </p>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <>
          {renderedPersonAvatar || null}
          {renderedOrganizationAvatar || null}
        </>
      )}
    </div>
  );
}

/**
 * Battery `col-sidebar` — application navigation rail.
 *
 * @figma section node-id=7-1544 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=7-1544
 * @figma node-id=4-545 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=4-545
 * @figma node-id=4-522 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=4-522
 */
export function Sidebar({
  state = "collapsed",
  groups = defaultGroups,
  bottomAction = defaultBottomAction,
  personAvatar,
  personName = "Martijn Weesjes",
  personRole = "Sys Admin",
  organizationAvatar,
  organizationName = "Lekker Wonen",
  onToggle,
  linkComponent,
  "aria-label": ariaLabel = "Primary navigation",
  className,
}: SidebarProps) {
  const isExpanded = state === "expanded";

  return (
    <aside
      data-slot="sidebar"
      data-state={state}
      aria-label={ariaLabel}
      className={cn(
        "flex h-full min-h-0 shrink-0 flex-col items-start overflow-hidden p-2",
        isExpanded ? "w-[200px] gap-2" : "w-12 gap-3",
        className,
      )}
    >
      <div className={cn("flex shrink-0 pb-6", isExpanded ? "w-full items-center justify-between" : "items-start")}>
        <button
          type="button"
          aria-label={isExpanded ? "Zijbalk inklappen" : "Zijbalk uitklappen"}
          onClick={onToggle}
          className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-small)]"
        >
          <SidebarLogo state={isExpanded ? "logo-expanded" : "logo-collapsed"} />
        </button>
        {isExpanded ? (
          <button
            type="button"
            aria-label="Zijbalk inklappen"
            onClick={onToggle}
            className="flex size-6 shrink-0 items-center justify-center text-[var(--color-foreground-muted)]"
          >
            <SidebarLogo state="logo-hover" />
          </button>
        ) : null}
      </div>

      <div className="flex min-h-0 w-full flex-1 flex-col items-start gap-2 overflow-y-auto overflow-x-hidden">
        {groups.map((group, groupIndex) => (
          <div key={group.id} className="contents">
            {groupIndex > 0 ? <SidebarRule state={state} /> : null}
            {isExpanded && group.label ? <SidebarCategory className="w-full shrink-0">{group.label}</SidebarCategory> : null}
            {group.items.map((item) => (
              <SidebarItem
                key={item.id}
                icon={item.icon}
                mode={state}
                state={item.current ? "current" : "active"}
                href={item.href}
                linkComponent={linkComponent}
                onClick={item.onClick}
                disabled={item.disabled}
              >
                {item.label}
              </SidebarItem>
            ))}
          </div>
        ))}
      </div>

      <SidebarFooter
        state={state}
        bottomAction={bottomAction}
        personAvatar={personAvatar}
        personName={personName}
        personRole={personRole}
        organizationAvatar={organizationAvatar}
        organizationName={organizationName}
        linkComponent={linkComponent}
      />
    </aside>
  );
}
