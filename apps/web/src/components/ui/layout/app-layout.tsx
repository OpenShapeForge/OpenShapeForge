// SPDX-License-Identifier: BUSL-1.1
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { Toaster } from "sonner";
import { AppDocumentTitleManager } from "@/components/ui/layout/app-document-title-manager";
import { AppHealthBanner } from "@/components/ui/layout/app-health-banner";
import { AppLayoutShell } from "@/components/ui/layout/app-layout-shell";
import { AppShellProvider } from "@/components/ui/layout/app-shell-context";
import { SessionExpiryGuard } from "@/components/ui/layout/session-expiry-guard";
import { SessionProvider } from "@/components/ui/layout/session-provider";
import { RealtimeProvider } from "@/features/realtime/components/RealtimeProvider";
import type { NavItem } from "@/lib/navigation/types";
import { getCachedSession } from "@/lib/cached-session";
import { buildSettingsPanelGroups, buildSidebarEntries } from "@/lib/navigation/augment-nav-items";
import { isKnownPublicPath } from "@/lib/public-routes";
import { getActiveTenantShellOrganization } from "@/lib/server/active-tenant-shell";
import { filterNavItemsByRoles } from "@/lib/server/route-authz";

export type AppLayoutProps = {
  items: NavItem[];
  settingsPanelItems?: NavItem[];
  activeType: string;
  activeLang: string;
  children: ReactNode;
  className?: string;
};

function normalizeShellLang(lang: string): "en" | "nl" {
  return lang === "nl" ? "nl" : "en";
}

export async function AppLayout({
  items,
  settingsPanelItems = [],
  activeType,
  activeLang,
  children,
  className,
}: AppLayoutProps) {
  const pathname = (await headers()).get("x-app-pathname");
  const isKnownPublicRoute = isKnownPublicPath(pathname);
  const session = isKnownPublicRoute ? null : await getCachedSession();

  // Filter nav items by the live session's roles. Items pointing at entity
  // routes the persona cannot read are pruned. Non-entity routes pass through.
  const visibleItems = session?.roles
    ? filterNavItemsByRoles(items, session.roles)
    : items;
  const visibleSettingsPanelItems = session?.roles
    ? filterNavItemsByRoles(settingsPanelItems, session.roles)
    : settingsPanelItems;
  const sidebarEntries = buildSidebarEntries(visibleItems, activeLang, activeType);
  const settingsPanelGroups = buildSettingsPanelGroups(
    visibleSettingsPanelItems,
    activeLang,
    activeType,
  );

  const user = session?.user?.name
    ? { name: session.user.name, role: session.actorType }
    : undefined;
  const organization = await getActiveTenantShellOrganization(session);

  return (
    <AppShellProvider
      value={{
        items: sidebarEntries,
        settingsPanelGroups,
        activeLang: normalizeShellLang(activeLang),
        user,
        organization,
      }}
    >
      <SessionProvider session={session}>
        <RealtimeProvider>
          <AppDocumentTitleManager />
          <AppLayoutShell
            pathname={pathname ?? "/"}
            className={className}
          >
            <AppHealthBanner />
            {children}
          </AppLayoutShell>
          <Toaster />
          <SessionExpiryGuard lang={activeLang} />
        </RealtimeProvider>
      </SessionProvider>
    </AppShellProvider>
  );
}
