// SPDX-License-Identifier: BUSL-1.1
export function getSingleSearchParamValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function resolveLocalizedRoute(route: string | { en?: string; nl?: string } | undefined, lang: string): string {
  if (!route) {
    return "/";
  }

  if (typeof route === "string") {
    return route;
  }

  return route[lang as "en" | "nl"] ?? route.en ?? route.nl ?? "/";
}

export function resolveActiveDetailGroupId(config: any, requestedGroup: string | undefined): string {
  const defaultGroupId = config.defaultGroupId ?? config.groups?.[0]?.id ?? "overview";
  if (!requestedGroup) {
    return defaultGroupId;
  }

  return config.groups?.some((group: any) => group.id === requestedGroup)
    ? requestedGroup
    : defaultGroupId;
}

export function buildWorkspaceRowLink(
  listRoute: string,
  selectionParam: string,
  activeGroupId: string | undefined,
): string {
  const params = [`${selectionParam}=:id`];
  if (activeGroupId) {
    params.push(`group=${encodeURIComponent(activeGroupId)}`);
  }

  const separator = listRoute.includes("?") ? "&" : "?";
  return `${listRoute}${separator}${params.join("&")}`;
}
