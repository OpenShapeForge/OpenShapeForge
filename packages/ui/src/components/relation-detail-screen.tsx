// SPDX-License-Identifier: BUSL-1.1
"use client";

import type {
  ComponentPropsWithoutRef,
  ComponentType,
  ReactNode,
} from "react";
import {
  BookUser,
  Building2,
  ChevronRight,
  GitFork,
  Inbox,
  KeyRound,
  ListChecks,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Shovel,
  SlidersHorizontal,
  Vault,
  Wrench,
} from "lucide-react";

import { batteryThemeStyle } from "../lib/battery-theme";
import { cn } from "../lib/cn";
import { Button } from "./button";
import { Chip } from "./chip";
import { EntityHeader } from "./entity-header";
import { InboxMainContext } from "./inbox-main-context";
import { RowPanelheader } from "./row-panelheader";
import { RowSectionheader } from "./row-sectionheader";
import { Sidebar, type SidebarGroup } from "./sidebar";
import { TopnavTab } from "./topnav-tab";

type IconComponent = ComponentType<{ className?: string }>;
type Tone = "neutral" | "success" | "warning" | "danger";

export const relationDetailScreenFigmaBinding = {
  componentId: "1438:31661",
  fileKey: "CbKdajB2p4lAW3bBGcHBYd",
  name: "relatie (inbox-main-context)",
  nodeId: "854:13055",
} as const;

export interface RelationContactItem {
  icon: IconComponent;
  label: ReactNode;
}

export interface RelationLinkedItem {
  label: ReactNode;
  value: ReactNode;
  tone?: Tone;
}

export interface RelationActivityItem {
  icon: IconComponent;
  title: ReactNode;
  description: ReactNode;
  caseId?: ReactNode;
  date: ReactNode;
  channel?: ReactNode;
  channelTone?: "blue" | "green";
}

export interface RelationWorkAction {
  icon: IconComponent;
  label: ReactNode;
}

export interface RelationWorkCount {
  label: ReactNode;
  count: number;
}

export interface RelationDetailScreenProps
  extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  relationName: ReactNode;
  relationRole: ReactNode;
  relationImageSrc?: string;
  relationTags: ReactNode[];
  contacts: RelationContactItem[];
  related: RelationLinkedItem[];
  attention: RelationLinkedItem[];
  activityTabs: string[];
  currentActivityTab: string;
  activities: RelationActivityItem[];
  workActions: RelationWorkAction[];
  workCounts: RelationWorkCount[];
  onActivityTabChange?: (tab: string) => void;
  onAdd?: () => void;
  onEdit?: () => void;
  onMore?: () => void;
  onLinkedItemActivate?: (
    section: "related" | "attention",
    item: RelationLinkedItem,
    index: number,
  ) => void;
  onWorkActionActivate?: (action: RelationWorkAction, index: number) => void;
  onWorkCountActivate?: (item: RelationWorkCount, index: number) => void;
}

const sidebarGroups: SidebarGroup[] = [
  { id: "search", items: [{ id: "search", label: "Zoeken", icon: Search }] },
  {
    id: "work",
    items: [
      { id: "inbox", label: "Inbox", icon: Inbox },
      { id: "tasks", label: "Taken", icon: ListChecks },
    ],
  },
  {
    id: "data",
    items: [
      { id: "relations", label: "Relaties", icon: BookUser, current: true },
      { id: "property", label: "Vastgoed", icon: Building2 },
      { id: "contracts", label: "Contracten", icon: KeyRound },
      { id: "maintenance", label: "Onderhoud", icon: Wrench },
      { id: "finance", label: "Financieel", icon: Vault },
      { id: "projects", label: "Projecten", icon: Shovel },
    ],
  },
  {
    id: "settings",
    items: [
      { id: "flows", label: "Processen", icon: GitFork },
      { id: "configuration", label: "Instellingen", icon: SlidersHorizontal },
    ],
  },
];

function StatusDot({ tone = "neutral" }: { tone?: Tone }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        tone === "success" && "bg-[var(--color-brand-aquamarine-100)]",
        tone === "warning" && "bg-[var(--color-functional-orange-100)]",
        tone === "danger" && "bg-[var(--color-functional-red-100)]",
        tone === "neutral" && "bg-[var(--color-brand-platinum-60)]",
      )}
    />
  );
}

function ContactRow({ icon: Icon, label }: RelationContactItem) {
  return (
    <div className="flex h-10 items-center gap-3 border-b border-[var(--color-border-subtle)] px-4 text-[12px] leading-[12px] text-[var(--color-foreground-subtle)]">
      <span className="flex size-8 items-center justify-center rounded-[var(--radius-small)] bg-[var(--color-surface)] text-[var(--color-foreground-muted)]">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </div>
  );
}

function LinkedRow({
  item,
  onActivate,
}: {
  item: RelationLinkedItem;
  onActivate?: () => void;
}) {
  const { label, value, tone = "neutral" } = item;
  return (
    <button
      className="flex h-10 w-full items-center gap-3 px-4 text-left text-[13px] leading-[13px] disabled:cursor-default"
      disabled={!onActivate}
      onClick={onActivate}
      type="button"
    >
      <StatusDot tone={tone} />
      <span className="min-w-0 flex-1 text-[var(--color-foreground-subtle)]">{label}</span>
      <span className="min-w-0 max-w-[180px] truncate font-medium text-[var(--color-brand-indigo-120)]">
        {value}
      </span>
      <ChevronRight className="size-4 shrink-0 text-[var(--color-foreground-muted)]" aria-hidden="true" />
    </button>
  );
}

function RelationContextPanel(
  props: Pick<
    RelationDetailScreenProps,
    | "attention"
    | "contacts"
    | "onLinkedItemActivate"
    | "related"
    | "relationImageSrc"
    | "relationName"
    | "relationRole"
    | "relationTags"
  >,
) {
  return (
    <div className="flex size-full flex-col overflow-hidden bg-[var(--color-card)]">
      <RowPanelheader title="Context" showChevron={false} showClose={false} />
      <div className="px-4 py-6">
        <EntityHeader
          kind="person"
          size="M"
          title={props.relationName}
          role={props.relationRole}
          imageSrc={props.relationImageSrc}
          tags={props.relationTags.map((tag, index) => <Chip key={index}>{tag}</Chip>)}
        />
      </div>
      <RowSectionheader label="BEREIKBAARHEID" className="pt-4" />
      <div>{props.contacts.map((contact, index) => <ContactRow key={index} {...contact} />)}</div>
      <p className="px-4 py-4 text-[12px] leading-[12px] text-[var(--color-foreground-muted)]">
        Voorkeur: e-mail · Nederlands
      </p>
      <RowSectionheader label="GERELATEERD" />
      <div>{props.related.map((item, index) => <LinkedRow key={index} item={item} onActivate={props.onLinkedItemActivate ? () => props.onLinkedItemActivate?.("related", item, index) : undefined} />)}</div>
      <RowSectionheader label="AANDACHTSPUNTEN" />
      <div>{props.attention.map((item, index) => <LinkedRow key={index} item={item} onActivate={props.onLinkedItemActivate ? () => props.onLinkedItemActivate?.("attention", item, index) : undefined} />)}</div>
    </div>
  );
}

function ActivityItem({ icon: Icon, title, description, caseId, channel, channelTone = "blue", date }: RelationActivityItem) {
  return (
    <li className="grid grid-cols-[32px_minmax(0,1fr)] gap-4 py-2">
      <span className="flex size-8 items-center justify-center rounded-[var(--radius-small)] border border-[var(--color-border-subtle)] text-[var(--color-foreground-muted)]">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="min-w-0 text-[13px] leading-[18px] text-[var(--color-foreground-subtle)]">
          <span className="font-medium text-[var(--color-foreground)]">{title}</span>{" "}
          {description}{" "}
          {caseId ? <span className="rounded-[2px] bg-[var(--color-border-muted)] px-1 text-[var(--color-foreground-subtle)]">{caseId}</span> : null}{" "}
          {channel ? (
            <span className={cn("rounded-[2px] px-1 text-[var(--color-foreground-subtle)]", channelTone === "green" ? "bg-[var(--color-brand-aquamarine-20)]" : "bg-[var(--color-brand-smartblue-20)]")}>
              {channel}
            </span>
          ) : null}
        </p>
        <p className="mt-0.5 text-[12px] leading-[12px] text-[var(--color-foreground-muted)]">{date}</p>
      </div>
    </li>
  );
}

function RelationActivityPanel({
  tabs,
  currentTab,
  activities,
  relationName,
  onActivityTabChange,
  onAdd,
  onEdit,
  onMore,
}: {
  tabs: string[];
  currentTab: string;
  activities: RelationActivityItem[];
  relationName: ReactNode;
  onActivityTabChange?: (tab: string) => void;
  onAdd?: () => void;
  onEdit?: () => void;
  onMore?: () => void;
}) {
  return (
    <section className="flex size-full min-w-0 flex-col overflow-hidden bg-[var(--color-card)]">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--color-border-subtle)] px-4 text-[13px] leading-[13px]">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[var(--color-foreground-subtle)]">{relationName}</span>
          <ChevronRight className="size-4 shrink-0 text-[var(--color-foreground-muted)]" aria-hidden="true" />
          <span className="truncate font-semibold text-[var(--color-foreground-subtle)]">Recente activiteit</span>
        </div>
        <Button aria-label="Toevoegen" disabled={!onAdd} onClick={onAdd} size="icon-xs" variant="outline"><Plus className="size-3" aria-hidden="true" /></Button>
      </div>
      <div className="flex h-16 shrink-0 items-center justify-between gap-3 px-4">
        <div className="flex min-w-0 flex-wrap gap-2">
          {tabs.map((tab) => <TopnavTab key={String(tab)} disabled={!onActivityTabChange} onClick={() => onActivityTabChange?.(tab)} title={tab} state={tab === currentTab ? "current" : "active"} />)}
        </div>
        <div className="flex shrink-0 gap-1">
          <Button variant="outline" size="icon-sm" aria-label="Bewerken" disabled={!onEdit} onClick={onEdit}><Pencil className="size-4" aria-hidden="true" /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="Meer" disabled={!onMore} onClick={onMore}><MoreHorizontal className="size-4" aria-hidden="true" /></Button>
        </div>
      </div>
      <ol className="min-h-0 flex-1 overflow-auto px-6 pb-8">
        {activities.map((activity, index) => <ActivityItem key={index} {...activity} />)}
      </ol>
    </section>
  );
}

function WorkActionRow({ action, onActivate }: { action: RelationWorkAction; onActivate?: () => void }) {
  const { icon: Icon, label } = action;
  return (
    <button className="flex h-[58px] w-full items-center gap-3 border-b border-[var(--color-border-subtle)] px-4 text-left text-[12px] font-medium leading-[12px] text-[var(--color-foreground)] disabled:cursor-default" disabled={!onActivate} onClick={onActivate} type="button">
      <span className="flex size-8 items-center justify-center rounded-[var(--radius-small)] bg-[var(--color-brand-smartblue-80)] text-white">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <ChevronRight className="size-4 shrink-0 text-[var(--color-foreground-muted)]" aria-hidden="true" />
    </button>
  );
}

function RelationWorkPanel({ actions, counts, onActionActivate, onCountActivate }: { actions: RelationWorkAction[]; counts: RelationWorkCount[]; onActionActivate?: RelationDetailScreenProps["onWorkActionActivate"]; onCountActivate?: RelationDetailScreenProps["onWorkCountActivate"] }) {
  return (
    <div className="flex size-full flex-col overflow-hidden bg-[var(--color-card)]">
      <RowPanelheader title="Nu regelen" showChevron={false} showClose={false} />
      <RowSectionheader label="ACTIES" />
      <div className="px-2">{actions.map((action, index) => <WorkActionRow key={index} action={action} onActivate={onActionActivate ? () => onActionActivate(action, index) : undefined} />)}</div>
      <RowSectionheader label="LOPENDE ZAKEN" />
      <div className="px-4">
        {counts.map((item, index) => (
          <button key={index} className="flex h-10 w-full items-center gap-3 border-b border-[var(--color-border-subtle)] text-left text-[12px] font-medium leading-[12px] disabled:cursor-default" disabled={!onCountActivate} onClick={onCountActivate ? () => onCountActivate(item, index) : undefined} type="button">
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            <span className="rounded-full bg-[var(--color-border-muted)] px-2 py-0.5 text-[var(--color-foreground-muted)]">{item.count}</span>
            <ChevronRight className="size-4 shrink-0 text-[var(--color-foreground-muted)]" aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Habeon 1.3 relation detail screen.
 *
 * @figma file-key=CbKdajB2p4lAW3bBGcHBYd
 * @figma name="relatie (inbox-main-context)"
 * @figma node-id=854:13055
 * @figma component-id=1438:31661
 */
export function RelationDetailScreen({
  relationName,
  relationRole,
  relationImageSrc,
  relationTags,
  contacts,
  related,
  attention,
  activityTabs,
  currentActivityTab,
  activities,
  workActions,
  workCounts,
  onActivityTabChange,
  onAdd,
  onEdit,
  onLinkedItemActivate,
  onMore,
  onWorkActionActivate,
  onWorkCountActivate,
  className,
  style,
  ...props
}: RelationDetailScreenProps) {
  return (
    <div
      data-slot="relation-detail-screen"
      data-figma-file-key={relationDetailScreenFigmaBinding.fileKey}
      data-figma-node-id={relationDetailScreenFigmaBinding.nodeId}
      className={cn("size-full min-h-[720px] min-w-[1080px] overflow-auto", className)}
      style={batteryThemeStyle(style)}
      {...props}
    >
      <InboxMainContext
        tabs={false}
        topNav={false}
        resizable={false}
        sidebar={<Sidebar groups={sidebarGroups} state="collapsed" />}
        left={<RelationContextPanel attention={attention} contacts={contacts} onLinkedItemActivate={onLinkedItemActivate} related={related} relationImageSrc={relationImageSrc} relationName={relationName} relationRole={relationRole} relationTags={relationTags} />}
        main={<RelationActivityPanel activities={activities} currentTab={currentActivityTab} onActivityTabChange={onActivityTabChange} onAdd={onAdd} onEdit={onEdit} onMore={onMore} relationName={relationName} tabs={activityTabs} />}
        right={<RelationWorkPanel actions={workActions} counts={workCounts} onActionActivate={onWorkActionActivate} onCountActivate={onWorkCountActivate} />}
        leftSize={{ defaultWidth: 320, minWidth: 280, maxWidth: 420 }}
        mainSize={{ minWidth: 520, weight: 1 }}
        rightSize={{ defaultWidth: 480, minWidth: 360, maxWidth: 560 }}
        leftClassName="bg-[var(--color-card)]"
        mainClassName="p-0"
        rightClassName="bg-[var(--color-card)]"
        contentClassName="bg-[var(--color-card)]"
      />
    </div>
  );
}
