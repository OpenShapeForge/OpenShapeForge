// SPDX-License-Identifier: BUSL-1.1
import type { FormGroupInterpretation } from "@/features/renderer/form-definition";

export type RendererSearchParams = Record<string, string | string[] | undefined>;

export type RendererTabNavigation = {
  pathname: string;
  searchParams?: RendererSearchParams;
  defaultTabId?: string;
  paramName?: string;
};

export function getGroupInterpretation(
  interpretations: readonly FormGroupInterpretation[] | undefined,
  level: number,
): FormGroupInterpretation {
  if (!interpretations || interpretations.length === 0) {
    return "group";
  }

  return interpretations[Math.min(level, interpretations.length - 1)] ?? "group";
}

/**
 * Builds shareable tab links for server-rendered detail pages without needing a
 * dedicated wrapper component in front of the renderer.
 */
export function buildRendererTabHref(
  tabId: string,
  navigation: RendererTabNavigation,
  fallbackDefaultTabId: string,
): string {
  const nextSearchParams = toUrlSearchParams(navigation.searchParams);
  const defaultTabId = navigation.defaultTabId ?? fallbackDefaultTabId;
  const paramName = navigation.paramName ?? "tab";

  if (tabId === defaultTabId) {
    nextSearchParams.delete(paramName);
  } else {
    nextSearchParams.set(paramName, tabId);
  }

  const query = nextSearchParams.toString();
  return query ? `${navigation.pathname}?${query}` : navigation.pathname;
}

function toUrlSearchParams(searchParams?: RendererSearchParams): URLSearchParams {
  const nextSearchParams = new URLSearchParams();

  if (!searchParams) {
    return nextSearchParams;
  }

  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) {
      value.forEach((item) => {
        nextSearchParams.append(key, item);
      });
      continue;
    }

    if (value !== undefined) {
      nextSearchParams.set(key, value);
    }
  }

  return nextSearchParams;
}
