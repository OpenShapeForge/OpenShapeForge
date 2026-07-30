// SPDX-License-Identifier: BUSL-1.1
"use client";

import type {
  ComponentPropsWithoutRef,
  CSSProperties,
  ReactNode,
} from "react";

import { cn } from "../lib/cn";
import { Chip } from "./chip";
import { EntityHeader, type EntityHeaderKind } from "./entity-header";
import { RowPanelheader } from "./row-panelheader";
import { RowSectionheader } from "./row-sectionheader";
import { TopnavTab } from "./topnav-tab";

export const datascreenRelationsFigmaBinding = {
  fileKey: "CbKdajB2p4lAW3bBGcHBYd",
  name: "Datascreen \\ Relations",
  nodeId: "473:8398",
} as const;

export interface DatascreenTabsProps
  extends Omit<ComponentPropsWithoutRef<"div">, "onChange"> {
  /** Ordered tab labels. */
  tabs: string[];
  /** Active tab label. Defaults to the first tab. */
  current?: string;
  /** Called when a tab is selected. */
  onChange?: (tab: string) => void;
}

/**
 * Tab row from the relations datascreen. The individual tabs reuse the shared
 * `TopnavTab` primitive's Figma underline presentation.
 *
 * @figma file-key=CbKdajB2p4lAW3bBGcHBYd
 * @figma node-id=519:12813
 */
export function DatascreenTabs({
  tabs,
  current = tabs[0],
  onChange,
  className,
  ...props
}: DatascreenTabsProps) {
  return (
    <div
      data-slot="datascreen-tabs"
      className={cn("flex h-[45px] items-stretch gap-4 px-4", className)}
      {...props}
    >
      {tabs.map((tab) => {
        const selected = tab === current;
        return (
          <TopnavTab
            key={tab}
            aria-current={selected ? "page" : undefined}
            onClick={() => onChange?.(tab)}
            presentation="underline"
            state={selected ? "current" : "active"}
            title={tab}
            className="min-w-0"
          />
        );
      })}
    </div>
  );
}

export interface DatascreenRelationRowProps
  extends ComponentPropsWithoutRef<"div"> {
  /** Row content, usually `EntityHeader` in compact size. */
  children: ReactNode;
}

/**
 * Fixed-height relation row frame used under each section.
 *
 * @figma file-key=CbKdajB2p4lAW3bBGcHBYd
 * @figma name="row-relation"
 */
export function DatascreenRelationRow({
  children,
  className,
  ...props
}: DatascreenRelationRowProps) {
  return (
    <div
      data-slot="datascreen-relation-row"
      className={cn("flex h-10 min-w-0 items-center px-2", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export interface DatascreenRelationSectionProps
  extends ComponentPropsWithoutRef<"section"> {
  /** Section label, e.g. CONTRACT or PERSONEN. */
  label: ReactNode;
  /** Section rows. */
  children: ReactNode;
}

/**
 * Relations datascreen section: Figma `row-sectionheader` plus one or more
 * `row-relation` children.
 *
 * @figma file-key=CbKdajB2p4lAW3bBGcHBYd
 * @figma node-id=554:15912
 * @figma node-id=554:15881
 * @figma node-id=554:15835
 * @figma node-id=519:13107
 */
export function DatascreenRelationSection({
  label,
  children,
  className,
  ...props
}: DatascreenRelationSectionProps) {
  return (
    <section
      data-slot="datascreen-relation-section"
      className={cn("min-w-0", className)}
      {...props}
    >
      <RowSectionheader label={label} className="h-[42px] shrink-0" />
      <div className="mt-1 flex min-w-0 flex-col gap-1">{children}</div>
    </section>
  );
}

export interface DatascreenRelationRecord {
  kind: Exclude<EntityHeaderKind, "unit">;
  title: ReactNode;
  role?: ReactNode;
  subtitle?: ReactNode;
  imageSrc?: string;
  imageAlt?: string;
  initials?: string;
  icon?: ReactNode;
  tags?: ReactNode[];
  showRole?: boolean;
  showNameAndRoll?: boolean;
  showNameAndRole?: boolean;
  showSubtitle?: boolean;
  showTags?: boolean;
}

export interface DatascreenRelationGroup {
  label: ReactNode;
  records: DatascreenRelationRecord[];
}

export interface DatascreenUnitRecord {
  kind?: EntityHeaderKind;
  title: ReactNode;
  role?: ReactNode;
  subtitle?: ReactNode;
  imageSrc?: string;
  imageAlt?: string;
  initials?: string;
  chips?: ReactNode[];
  state?: "active" | "compact";
  variant?: string;
  showRole?: boolean;
  showNameAndRoll?: boolean;
  showNameAndRole?: boolean;
  showSubtitle?: boolean;
  showTags?: boolean;
}

export interface DatascreenRelationsProps
  extends Omit<ComponentPropsWithoutRef<"aside">, "title"> {
  /** Panel title in the row-panelheader. */
  title?: ReactNode;
  /** Selected unit identity shown at the top of the datascreen. */
  unit?: DatascreenUnitRecord;
  /** Tab labels. */
  tabs?: string[];
  /** Active tab label. */
  currentTab?: string;
  /** Called when a tab is selected. */
  onTabChange?: (tab: string) => void;
  /** Relation groups rendered below the tab row. */
  groups?: DatascreenRelationGroup[];
  /** Show the close icon in the panel header. */
  showClose?: boolean;
  /** Called when the close icon is clicked. */
  onClose?: () => void;
}

const defaultUnit: DatascreenUnitRecord = {
  title: "4 Privet Drive",
  subtitle: "RG12 9YZ Little Whinging, Surrey",
  chips: ["Inbox", "Inbox", "Inbox"],
};

const defaultGroups: DatascreenRelationGroup[] = [
  {
    label: "CONTRACT",
    records: [{ kind: "contract", title: "4 Privet Drive" }],
  },
  {
    label: "ORGANISATIE",
    records: [{ kind: "organisation", title: "Gryffindor" }],
  },
  {
    label: "HUISHOUDEN",
    records: [
      {
        kind: "household",
        title: "H. Potter & H. Granger",
        initials: "PG",
        showSubtitle: false,
      },
    ],
  },
  {
    label: "PERSONEN",
    records: [
      { kind: "person", title: "Harry Potter", showSubtitle: false },
      { kind: "person", title: "Hermione Granger", showSubtitle: false },
    ],
  },
];

/**
 * Figma `Datascreen \ Relations` panel.
 *
 * @figma file-key=CbKdajB2p4lAW3bBGcHBYd
 * @figma name="Datascreen \\ Relations"
 * @figma node-id=473:8398
 */
export function DatascreenRelations({
  title = "Relaties",
  unit = defaultUnit,
  tabs = ["Relaties", "Groepen"],
  currentTab = tabs[0],
  onTabChange,
  groups = defaultGroups,
  showClose = true,
  onClose,
  className,
  style,
  ...props
}: DatascreenRelationsProps) {
  const chips = unit.chips ?? [];

  return (
    <aside
      data-slot="datascreen-relations"
      data-figma-file-key={datascreenRelationsFigmaBinding.fileKey}
      data-figma-name={datascreenRelationsFigmaBinding.name}
      data-figma-node-id={datascreenRelationsFigmaBinding.nodeId}
      className={cn(
        "flex min-h-[1064px] w-[400px] min-w-0 flex-col overflow-hidden bg-[var(--color-card)] text-[var(--color-foreground)]",
        className,
      )}
      style={
        {
          "--datascreen-panel-width": "400px",
          ...style,
        } as CSSProperties
      }
      {...props}
    >
      <RowPanelheader
        title={title}
        showChevron={false}
        showClose={showClose}
        onClose={onClose}
        className="shrink-0"
      />

      <div className="mt-2 flex h-20 shrink-0 items-center px-2">
        <EntityHeader
          kind={unit.kind ?? "unit"}
          size="M"
          title={unit.title}
          role={unit.role}
          subtitle={unit.subtitle}
          imageSrc={unit.imageSrc}
          imageAlt={unit.imageAlt}
          initials={unit.initials}
          state={unit.state}
          variant={unit.variant}
          showRole={unit.showRole}
          showNameAndRoll={unit.showNameAndRoll}
          showNameAndRole={unit.showNameAndRole}
          showSubtitle={unit.showSubtitle}
          showTags={unit.showTags}
          tags={
            chips.length > 0
              ? chips.map((chip, index) => (
                  <Chip key={index}>{chip}</Chip>
                ))
              : undefined
          }
        />
      </div>

      <DatascreenTabs
        tabs={tabs}
        current={currentTab}
        onChange={onTabChange}
        className="mt-2 shrink-0"
      />

      <div className="flex min-w-0 flex-col pt-2">
        {groups.map((group, groupIndex) => (
          <DatascreenRelationSection key={groupIndex} label={group.label}>
            {group.records.map((record, recordIndex) => (
              <DatascreenRelationRow key={recordIndex}>
                <EntityHeader
                  kind={record.kind}
                  size="S"
                  title={record.title}
                  role={record.role}
                  subtitle={record.subtitle}
                  imageSrc={record.imageSrc}
                  imageAlt={record.imageAlt}
                  initials={record.initials}
                  icon={record.icon}
                  showRole={record.showRole}
                  showNameAndRoll={record.showNameAndRoll}
                  showNameAndRole={record.showNameAndRole}
                  showSubtitle={record.showSubtitle}
                  showTags={record.showTags}
                  tags={
                    record.tags && record.tags.length > 0
                      ? record.tags.map((chip, index) => (
                          <Chip key={index}>{chip}</Chip>
                        ))
                      : undefined
                  }
                />
              </DatascreenRelationRow>
            ))}
          </DatascreenRelationSection>
        ))}
      </div>
    </aside>
  );
}
