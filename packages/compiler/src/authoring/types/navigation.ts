// @ts-nocheck
import type { LocalizedText } from "./common.js";

export interface NavItem {
  key: string;
  label: LocalizedText;
  icon?: string;
  route: string;
  type?: string;
}

export interface Navigation {
  schemaVersion: number;
  kind: "navigation";
  sidebar: {
    title: string;
    items: NavItem[];
  };
}

export interface AppShellPage {
  component: string;
  entity?: string;
  context?: string;
  mode?: string;
}

export interface AppShellNavItem {
  key: string;
  label: LocalizedText;
  icon?: string;
  route?: LocalizedText;
  entity?: string | null;
  view?: string;
  context?: string;
  disabled?: boolean;
  children?: AppShellNavItem[];
}

export interface AppShell {
  schemaVersion: number;
  kind: "appShell";
  shell: { component: string; title: string };
  navigation: {
    component: string;
    sidebarItems?: AppShellNavItem[];
    settingsPanelItems?: AppShellNavItem[];
    items: AppShellNavItem[];
  };
}
