// SPDX-License-Identifier: BUSL-1.1
export function resolveRouteTemplate(
  template: string,
  row: unknown,
): string {
  return template.replace(/:([A-Za-z0-9_.]+)/g, (_, token: string) => {
    const value = token.split(".").reduce<unknown>((current, segment) => {
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        return undefined;
      }
      return (current as Record<string, unknown>)[segment];
    }, row);

    return value == null || value === ""
      ? ""
      : encodeURIComponent(String(value));
  });
}

export function resolveIdRouteTemplate(
  routeTemplate: string,
  id: string,
): string {
  return routeTemplate.replace(":id", id);
}
