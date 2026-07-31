// SPDX-License-Identifier: BUSL-1.1
export type TranslatableLabel = Record<string, string>;

export interface NavItem {
  key: string;
  label: TranslatableLabel;
  icon?: string;
  route?: TranslatableLabel;
  children?: NavItem[];
  context?: string;
  disabled?: boolean;
}

export interface SettingsPanelLink {
  label: string;
  href: string;
}

export interface SettingsPanelGroup {
  label: string;
  items: SettingsPanelLink[];
}

export interface ContextLabel {
  key: string;
  label: TranslatableLabel;
}

export type SidebarEntry =
  | { type: "item"; key: string; label: string; icon: string; href: string }
  | { type: "stub"; key: string; label: string; icon: string }
  | { type: "separator" }
  | { type: "category"; label: string };
