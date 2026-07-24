// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
import type {
  FieldEntry,
  LocalizedText,
  RelationshipUsage,
  TimelineConfig,
  ViewGroup,
  ViewGroupOverride,
} from "./types.js";

type GroupContainer = {
  groups?: ViewGroup[];
  groupsFrom?: string;
  groupOverrides?: Record<string, ViewGroupOverride>;
};

export interface ResolvedViewGroup {
  id: string;
  title?: LocalizedText;
  label?: LocalizedText;
  icon?: string;
  render?: string;
  fields?: FieldEntry[];
  relationships?: RelationshipUsage[];
  relationship?: string | RelationshipUsage;
  groups?: ResolvedViewGroup[];
  timeline?: TimelineConfig;
}

function getLocalizedSeed(value?: LocalizedText): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  return value.en ?? value.nl;
}

export function buildViewGroupId(
  group: Pick<ViewGroup, "id" | "title" | "label" | "fields">,
  fallbackId: string,
): string {
  const explicitId = group.id?.trim();
  if (explicitId) {
    return explicitId;
  }

  const seed = getLocalizedSeed(group.title)
    ?? getLocalizedSeed(group.label)
    ?? (typeof group.fields?.[0] === "string" ? group.fields[0] : group.fields?.[0]?.key)
    ?? fallbackId;

  return String(seed)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || fallbackId;
}

function mergeGroupOverride(
  group: ViewGroup,
  override: ViewGroupOverride | undefined,
): ViewGroup {
  if (!override) {
    return group;
  }

  return {
    ...group,
    ...override,
    title: override.title ?? group.title,
    label: override.label ?? group.label,
    icon: override.icon ?? group.icon,
    render: override.render ?? group.render,
    fields: override.fields ?? group.fields,
    relationships: override.relationships ?? group.relationships,
    relationship: override.relationship ?? group.relationship,
    groups: override.groups ?? group.groups,
    groupsFrom: override.groupsFrom ?? group.groupsFrom,
    groupOverrides: override.groupOverrides ?? group.groupOverrides,
    timeline: override.timeline ?? group.timeline,
  };
}

type ResolveOptions = {
  groupSets?: Record<string, ViewGroup[]>;
  path?: string;
};

function resolveGroupSet(
  name: string,
  options: ResolveOptions,
  resolutionStack: string[],
): ViewGroup[] {
  const groups = options.groupSets?.[name];
  if (!groups) {
    const location = options.path ? ` at ${options.path}` : "";
    throw new Error(`Unknown group set '${name}'${location}`);
  }

  if (resolutionStack.includes(name)) {
    const chain = [...resolutionStack, name].join(" -> ");
    throw new Error(`Circular group set reference detected: ${chain}`);
  }

  return groups;
}

function resolveGroupList(
  container: GroupContainer | undefined,
  options: ResolveOptions,
  fallbackPrefix: string,
  resolutionStack: string[],
): ResolvedViewGroup[] {
  if (!container) {
    return [];
  }

  const resolved: ResolvedViewGroup[] = [];

  if (container.groupsFrom) {
    const referencedGroups = resolveGroupSet(container.groupsFrom, options, resolutionStack);
    const nextStack = [...resolutionStack, container.groupsFrom];

    for (const [index, group] of referencedGroups.entries()) {
      const fallbackId = `${container.groupsFrom}-group-${index + 1}`;
      const resolvedId = buildViewGroupId(group, fallbackId);
      const override = container.groupOverrides?.[resolvedId];
      resolved.push(resolveGroupDefinition(mergeGroupOverride(group, override), options, resolvedId, nextStack));
    }
  }

  for (const [index, group] of (container.groups ?? []).entries()) {
    resolved.push(resolveGroupDefinition(group, options, `${fallbackPrefix}-group-${index + 1}`, resolutionStack));
  }

  return resolved;
}

function resolveGroupDefinition(
  group: ViewGroup,
  options: ResolveOptions,
  fallbackId: string,
  resolutionStack: string[],
): ResolvedViewGroup {
  const id = buildViewGroupId(group, fallbackId);

  return {
    id,
    title: group.title,
    label: group.label,
    icon: group.icon,
    render: group.render,
    fields: group.fields,
    relationships: group.relationships,
    relationship: group.relationship,
    groups: resolveGroupList(group, options, id, resolutionStack),
    timeline: group.timeline,
  };
}

export function resolveViewGroups(
  container: GroupContainer | undefined,
  options: ResolveOptions = {},
  fallbackPrefix = "group",
): ResolvedViewGroup[] {
  return resolveGroupList(container, options, fallbackPrefix, []);
}
