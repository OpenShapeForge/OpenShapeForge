// SPDX-License-Identifier: BUSL-1.1
import type {
  NavItem,
  SettingsPanelGroup,
  SidebarEntry,
  TranslatableLabel,
} from "@/lib/navigation/types";

/**
 * Tenant administration. Present for every deployment because the API surface
 * it configures is always there; the page itself explains its own emptiness to
 * a user who lacks the management role, rather than the nav guessing.
 */
const API_KEYS_ITEM: NavItem = {
  key: "api-keys",
  label: { en: "API keys", nl: "API-sleutels" },
  icon: "KeyRound",
  route: { en: "/settings/api-keys", nl: "/settings/api-keys" },
};

/**
 * Setup entries. A plugin's screens reach the sidebar through its own
 * authoring layer (`kind: appShellPatch` on `menu.yaml`), never from here.
 */
function isToolingItem(item: NavItem): boolean {
  return item.key === API_KEYS_ITEM.key || item.route?.en === API_KEYS_ITEM.route?.en;
}

function ensureToolingPresent(items: NavItem[]): NavItem[] {
  return items.some(isToolingItem) ? [...items] : [...items, API_KEYS_ITEM];
}

function resolveLabel(label: TranslatableLabel, lang: string): string {
  return label[lang] ?? label.en ?? label.nl ?? Object.values(label)[0] ?? "";
}

function resolveHref(route: TranslatableLabel | undefined, lang: string): string | null {
  if (!route) return null;
  return route[lang] ?? route.en ?? route.nl ?? null;
}

function flattenToEntries(items: NavItem[], lang: string, activeType: string): SidebarEntry[] {
  const result: SidebarEntry[] = [];

  for (const item of items) {
    if (item.context && item.context !== activeType) continue;

    // Items with children but no route → category section
    if (item.children?.length && !item.route) {
      const visibleChildren = item.children.filter(
        (child) => !child.context || child.context === activeType,
      );
      if (visibleChildren.length === 0) continue;

      if (result.length > 0) result.push({ type: "separator" });
      result.push({ type: "category", label: resolveLabel(item.label, lang) });

      for (const child of visibleChildren) {
        if (child.disabled) {
          result.push({
            type: "stub",
            key: child.key,
            label: resolveLabel(child.label, lang),
            icon: child.icon ?? "Circle",
          });
          continue;
        }

        const href = resolveHref(child.route, lang);
        if (!href) continue;
        result.push({
          type: "item",
          key: child.key,
          label: resolveLabel(child.label, lang),
          icon: child.icon ?? "Circle",
          href,
        });
      }
    } else {
      if (item.disabled) {
        result.push({
          type: "stub",
          key: item.key,
          label: resolveLabel(item.label, lang),
          icon: item.icon ?? "Circle",
        });
        continue;
      }

      const href = resolveHref(item.route, lang);
      if (!href) continue;
      result.push({
        type: "item",
        key: item.key,
        label: resolveLabel(item.label, lang),
        icon: item.icon ?? "Circle",
        href,
      });
    }
  }

  return result;
}

export function buildSidebarEntries(
  items: NavItem[],
  lang: string,
  activeType: string,
): SidebarEntry[] {
  const augmented = ensureToolingPresent(items);
  const mainItems = augmented.filter((item) => !isToolingItem(item));
  const toolingItems = augmented.filter((item) => isToolingItem(item));

  const entries = flattenToEntries(mainItems, lang, activeType);

  if (toolingItems.length > 0) {
    entries.push({ type: "separator" });
    entries.push({ type: "category", label: lang === "nl" ? "Inrichting" : "Setup" });
    for (const item of toolingItems) {
      const visibleChildren = item.children?.filter(
        (child) => !child.context || child.context === activeType,
      ) ?? [];
      if (visibleChildren.length > 0) {
        for (const child of visibleChildren) {
          if (child.disabled) {
            entries.push({
              type: "stub",
              key: child.key,
              label: resolveLabel(child.label, lang),
              icon: child.icon ?? item.icon ?? "Circle",
            });
            continue;
          }

          const href = resolveHref(child.route, lang);
          if (!href) continue;
          entries.push({
            type: "item",
            key: child.key,
            label: resolveLabel(child.label, lang),
            icon: child.icon ?? item.icon ?? "Circle",
            href,
          });
        }
        continue;
      }

      if (item.disabled) {
        entries.push({
          type: "stub",
          key: item.key,
          label: resolveLabel(item.label, lang),
          icon: item.icon ?? "Circle",
        });
        continue;
      }

      const href = resolveHref(item.route, lang);
      if (!href) continue;
      entries.push({
        type: "item",
        key: item.key,
        label: resolveLabel(item.label, lang),
        icon: item.icon ?? "Circle",
        href,
      });
    }
  }

  return entries;
}

export function buildSettingsPanelGroups(
  items: NavItem[],
  lang: string,
  activeType: string,
): SettingsPanelGroup[] {
  const groups: SettingsPanelGroup[] = [];

  for (const item of items) {
    if (item.context && item.context !== activeType) continue;

    const visibleChildren = item.children?.filter(
      (child) => !child.context || child.context === activeType,
    ) ?? [];
    if (visibleChildren.length === 0) continue;

    const links = visibleChildren
      .filter((child) => !child.disabled)
      .map((child) => {
        const href = resolveHref(child.route, lang);
        return href
          ? {
              label: resolveLabel(child.label, lang),
              href,
            }
          : null;
      })
      .filter((link): link is { label: string; href: string } => link !== null);

    if (links.length === 0) continue;
    groups.push({
      label: resolveLabel(item.label, lang),
      items: links,
    });
  }

  return groups;
}
