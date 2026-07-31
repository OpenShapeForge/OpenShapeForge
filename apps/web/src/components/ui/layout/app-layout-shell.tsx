// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import {
  BaseLayout,
  type BaseLayoutProps,
} from "@openshapeforge/ui/base-layout";
import { AppSidebarNav } from "@/components/ui/app-sidebar-nav";
import { isKnownPublicPath } from "@/lib/public-routes";
import { cn } from "@/lib/utils";

const SIDEBAR_HOVER_EXPAND_DELAY_MS = 30_000;

interface AppLayoutShellProps {
  /** Request pathname from the server (e.g. `x-app-pathname`) — avoids hydration mismatches vs `usePathname()` during SSR. */
  pathname: string;
  children: ReactNode;
  className?: string;
}

type AppBaseLayoutProps = Omit<BaseLayoutProps, "sidebar"> & {
  /** Optional app-sidebar override. Defaults to the primary app navigation. */
  sidebar?: ReactNode | false;
  /** Optional class for the full-viewport wrapper around the Battery layout. */
  wrapperClassName?: string;
};

function AppSidebarSlot() {
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expandedByHoverRef = useRef(false);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  const collapse = () => {
    setSidebarExpanded(false);
    expandedByHoverRef.current = false;
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  const expandByClick = () => {
    expandedByHoverRef.current = false;
    setSidebarExpanded(true);
  };

  const handleNavigate = () => {
    if (expandedByHoverRef.current) {
      collapse();
    }
  };

  const handleSidebarMouseEnter = () => {
    if (sidebarExpanded) return;
    hoverTimerRef.current = setTimeout(() => {
      expandedByHoverRef.current = true;
      setSidebarExpanded(true);
    }, SIDEBAR_HOVER_EXPAND_DELAY_MS);
  };

  const handleSidebarMouseLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    if (sidebarExpanded && expandedByHoverRef.current) {
      collapse();
    }
  };

  return (
    <div
      className={cn("h-full shrink-0", sidebarExpanded ? "w-[200px]" : "w-12")}
      onMouseEnter={handleSidebarMouseEnter}
      onMouseLeave={handleSidebarMouseLeave}
    >
      {sidebarExpanded ? (
        <AppSidebarNav
          expanded
          onToggle={collapse}
          onNavigate={handleNavigate}
          className="h-full"
        />
      ) : (
        <AppSidebarNav
          expanded={false}
          onToggle={expandByClick}
          className="h-full"
        />
      )}
    </div>
  );
}

export function AppBaseLayout({
  sidebar,
  wrapperClassName,
  className,
  ...props
}: AppBaseLayoutProps) {
  const resolvedSidebar =
    sidebar === undefined ? <AppSidebarSlot /> : sidebar;

  return (
    <div
      className={cn(
        "relative h-svh w-full min-w-0 min-h-0 overflow-hidden bg-background text-foreground",
        wrapperClassName,
      )}
    >
      <BaseLayout
        {...props}
        sidebar={resolvedSidebar}
        className={cn("h-full", className)}
      />
    </div>
  );
}

export function AppLayoutShell({
  pathname,
  children,
  className,
}: AppLayoutShellProps) {
  const currentPathname = usePathname() ?? pathname;
  const isPublicRoute = isKnownPublicPath(currentPathname);

  if (isPublicRoute) {
    return <>{children}</>;
  }

  const isWorkflowDesignerRoute =
    currentPathname === "/workflow-designer" ||
    currentPathname.startsWith("/workflow-designer/");
  const isWorkflowInstanceRoute =
    currentPathname === "/workflow-instances" ||
    currentPathname.startsWith("/workflow-instances/");
  const isKlantgesprekkenRoute =
    currentPathname === "/klantgesprekken" ||
    currentPathname.startsWith("/klantgesprekken/");
  const isRelationPageRoute =
    /^\/(relations|relaties)\/[^/]+$/.test(currentPathname);
  const routeOwnsBaseLayout =
    isKlantgesprekkenRoute ||
    isWorkflowDesignerRoute ||
    isWorkflowInstanceRoute ||
    isRelationPageRoute;

  const content = (
    <main
      data-slot="app-shell-content"
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <div
        className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-auto"
      >
        {children}
      </div>
    </main>
  );

  if (isRelationPageRoute) {
    return (
      <div
        data-slot="relation-page-shell"
        className={cn(
          "flex h-svh min-h-0 min-w-0 flex-col overflow-hidden",
          className,
        )}
      >
        {children}
      </div>
    );
  }

  if (routeOwnsBaseLayout) {
    return <>{children}</>;
  }

  return (
    <AppBaseLayout
      variant="main"
      tabs={false}
      resizable={false}
      wrapperClassName={className}
      mainClassName="items-stretch overflow-hidden p-0"
      cardClassName="overflow-auto"
      main={content}
    />
  );
}
