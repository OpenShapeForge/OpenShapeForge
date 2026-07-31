// SPDX-License-Identifier: BUSL-1.1
import type { ReactNode } from "react";
import {
  BaseLayout,
  type BaseLayoutColumnSize,
  type BaseLayoutVariant,
} from "@openshapeforge/ui";
import type { WorkspaceColumn } from "./types";

interface WorkspaceLayoutParts {
  pageHeader: ReactNode;
  sidebar?: WorkspaceColumn;
  list?: WorkspaceColumn;
  body: WorkspaceColumn;
  related?: WorkspaceColumn;
}

function workspaceColumnSize(column: WorkspaceColumn): BaseLayoutColumnSize {
  if (typeof column.size === "number") {
    return {
      defaultWidth: column.size,
      minWidth: column.min,
      maxWidth: column.max,
    };
  }

  const weight = Number.parseFloat(column.size);
  return {
    weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
    minWidth: column.min,
    maxWidth: column.max,
  };
}

function ScrollSlot({ children }: { children: ReactNode }) {
  return (
    <div className="h-full min-h-0 min-w-0 overflow-auto">
      {children}
    </div>
  );
}

export function WorkspaceBatteryLayout({
  variant,
  left,
  main,
  right,
  leftSize,
  mainSize,
  rightSize,
}: {
  variant: BaseLayoutVariant;
  left?: ReactNode;
  main: ReactNode;
  right?: ReactNode;
  leftSize?: BaseLayoutColumnSize;
  mainSize?: BaseLayoutColumnSize;
  rightSize?: BaseLayoutColumnSize;
}) {
  return (
    <BaseLayout
      variant={variant}
      sidebar={false}
      tabs={false}
      className="h-full rounded-none bg-card p-0 outline-none"
      cardClassName="rounded-none outline-none"
      left={left}
      main={main}
      right={right}
      leftSize={leftSize}
      mainSize={mainSize}
      rightSize={rightSize}
      leftClassName="bg-card"
      mainClassName="bg-card p-0"
      rightClassName="bg-card/30"
      storageKey="base-layout"
    />
  );
}

function scrollColumnContent(column: WorkspaceColumn, contentOverride?: ReactNode) {
  return <ScrollSlot>{contentOverride ?? column.content}</ScrollSlot>;
}

function composeLeftSlot({
  sidebar,
  list,
}: {
  sidebar?: WorkspaceColumn;
  list?: WorkspaceColumn;
}) {
  if (sidebar && list) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-col">
        <div className="max-h-[40%] shrink-0 overflow-auto border-b border-border/60">
          {sidebar.content}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{list.content}</div>
      </div>
    );
  }

  if (sidebar) return scrollColumnContent(sidebar);
  if (list) return scrollColumnContent(list);
  return null;
}

function HeaderedBody({
  pageHeader,
  children,
}: {
  pageHeader: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="shrink-0 px-4 pt-4 lg:px-6">{pageHeader}</div>
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-4 lg:px-6">{children}</div>
    </div>
  );
}

function HeaderedColumns({
  pageHeader,
  children,
}: {
  pageHeader: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="shrink-0 px-4 pt-4 lg:px-6">{pageHeader}</div>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

export function renderWorkspaceLayout(variant: string, parts: WorkspaceLayoutParts) {
  const { pageHeader, sidebar, list, body, related } = parts;

  switch (variant) {
    case "body":
      return <WorkspaceBatteryLayout variant="main" main={scrollColumnContent(body)} mainSize={workspaceColumnSize(body)} />;
    case "page-header-body":
      return (
        <WorkspaceBatteryLayout
          variant="main"
          main={<HeaderedBody pageHeader={pageHeader}>{body.content}</HeaderedBody>}
          mainSize={workspaceColumnSize(body)}
        />
      );
    case "sidebar-body":
      return (
        <WorkspaceBatteryLayout
          variant="inbox-main"
          left={scrollColumnContent(sidebar!)}
          main={scrollColumnContent(body)}
          leftSize={workspaceColumnSize(sidebar!)}
          mainSize={workspaceColumnSize(body)}
        />
      );
    case "page-header-list-body":
      return (
        <HeaderedColumns pageHeader={pageHeader}>
          <WorkspaceBatteryLayout
            variant="inbox-main"
            left={scrollColumnContent(list!)}
            main={scrollColumnContent(body)}
            leftSize={workspaceColumnSize(list!)}
            mainSize={workspaceColumnSize(body)}
          />
        </HeaderedColumns>
      );
    case "page-header-list-body-related":
      return (
        <HeaderedColumns pageHeader={pageHeader}>
          <WorkspaceBatteryLayout
            variant="inbox-main-context"
            left={scrollColumnContent(list!)}
            main={scrollColumnContent(body)}
            right={scrollColumnContent(related!)}
            leftSize={workspaceColumnSize(list!)}
            mainSize={workspaceColumnSize(body)}
            rightSize={workspaceColumnSize(related!)}
          />
        </HeaderedColumns>
      );
    case "sidebar-page-body":
      return (
        <WorkspaceBatteryLayout
          variant="inbox-main"
          left={scrollColumnContent(sidebar!)}
          main={<HeaderedBody pageHeader={pageHeader}>{body.content}</HeaderedBody>}
          leftSize={workspaceColumnSize(sidebar!)}
          mainSize={workspaceColumnSize(body)}
        />
      );
    case "sidebar-page-header-list-body":
      return (
        <HeaderedColumns pageHeader={pageHeader}>
          <WorkspaceBatteryLayout
            variant="inbox-main"
            left={composeLeftSlot({ sidebar, list })}
            main={scrollColumnContent(body)}
            leftSize={workspaceColumnSize(list ?? sidebar!)}
            mainSize={workspaceColumnSize(body)}
          />
        </HeaderedColumns>
      );
    case "sidebar-page-header-list-body-related":
      return (
        <HeaderedColumns pageHeader={pageHeader}>
          <WorkspaceBatteryLayout
            variant="inbox-main-context"
            left={composeLeftSlot({ sidebar, list })}
            main={scrollColumnContent(body)}
            right={scrollColumnContent(related!)}
            leftSize={workspaceColumnSize(list ?? sidebar!)}
            mainSize={workspaceColumnSize(body)}
            rightSize={workspaceColumnSize(related!)}
          />
        </HeaderedColumns>
      );
    default:
      throw new Error(`EntityWorkspacePage: unknown layout variant "${variant}"`);
  }
}
