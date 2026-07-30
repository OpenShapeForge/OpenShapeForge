// SPDX-License-Identifier: BUSL-1.1
import { resolveIdRouteTemplate } from "@/lib/route-template";

export function buildSuccessRoute(routeTemplate: string, id: string): string {
  return resolveIdRouteTemplate(routeTemplate, id);
}

export function normalizeGeneratedFormFieldErrors<T extends Record<string, string> | undefined>(
  errors: T,
): T {
  return errors;
}
