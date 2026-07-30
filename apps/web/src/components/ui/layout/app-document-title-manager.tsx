// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useAppShell } from "@/components/ui/layout/app-shell-context";

const APP_NAME = "OpenShapeForge";
const EXPLICIT_TITLE_SELECTOR = "[data-app-document-title]";

function normalizeTitleSegment(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized ? normalized : null;
}

export function formatAppDocumentTitle(
  routeTitle: string | null | undefined,
  tenantName: string | null | undefined,
): string {
  const segments = [
    normalizeTitleSegment(routeTitle),
    normalizeTitleSegment(tenantName),
    APP_NAME,
  ].filter((segment): segment is string => Boolean(segment));

  return segments.join(" - ");
}

function readExplicitTitle(): string | null {
  const titleElement = document.querySelector<HTMLElement>(
    EXPLICIT_TITLE_SELECTOR,
  );

  return normalizeTitleSegment(
    titleElement?.getAttribute("data-app-document-title"),
  );
}

function readHeadingTitle(): string | null {
  const heading = document.querySelector<HTMLHeadingElement>("h1");
  return normalizeTitleSegment(heading?.innerText ?? heading?.textContent);
}

function readRouteTitle(): string | null {
  return readExplicitTitle() ?? readHeadingTitle();
}

export function AppDocumentTitleManager() {
  const pathname = usePathname();
  const shell = useAppShell();
  const tenantName = shell.organization?.name ?? null;

  useEffect(() => {
    const applyTitle = () => {
      if (typeof document === "undefined") {
        return;
      }

      const nextTitle = formatAppDocumentTitle(readRouteTitle(), tenantName);
      if (document.title !== nextTitle) {
        document.title = nextTitle;
      }
    };

    if (typeof document === "undefined" || !document.body) {
      return;
    }

    applyTitle();
    requestAnimationFrame(applyTitle);
    const timeoutIds = [
      window.setTimeout(applyTitle, 0),
      window.setTimeout(applyTitle, 250),
    ];

    const observerOptions: MutationObserverInit = {
      attributes: true,
      attributeFilter: ["data-app-document-title"],
      characterData: true,
      childList: true,
      subtree: true,
    };
    const observer = new MutationObserver(applyTitle);
    observer.observe(document.body, observerOptions);
    if (document.head) {
      observer.observe(document.head, observerOptions);
    }

    return () => {
      observer.disconnect();
      for (const timeoutId of timeoutIds) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [pathname, tenantName]);

  return null;
}
