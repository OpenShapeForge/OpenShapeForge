// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
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
  /** A named collection view of `entity`; absent opens its canonical collection. */
  view?: string;
  /** A page of standalone Operations, by page id. */
  page?: string;
  context?: string;
  disabled?: boolean;
  /** `false` keeps the entry out of MCP application openers; the browser item is unaffected. */
  mcp?: false;
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
