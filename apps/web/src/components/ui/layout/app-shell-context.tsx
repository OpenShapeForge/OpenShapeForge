// SPDX-License-Identifier: BUSL-1.1
"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { SettingsPanelGroup, SidebarEntry } from "@/lib/navigation/types";

export type AppShellValue = {
  items: SidebarEntry[];
  settingsPanelGroups?: SettingsPanelGroup[];
  activeLang: "en" | "nl";
  user?: { name: string; role?: string };
  organization?: {
    name: string;
    avatarStorageLocation?: string | null;
  };
};

const AppShellContext = createContext<AppShellValue | null>(null);

export function AppShellProvider({
  value,
  children,
}: {
  value: AppShellValue;
  children: ReactNode;
}) {
  return (
    <AppShellContext.Provider value={value}>{children}</AppShellContext.Provider>
  );
}

export function useAppShell() {
  const context = useContext(AppShellContext);
  if (!context) {
    throw new Error("useAppShell must be used within an AppShellProvider.");
  }
  return context;
}
