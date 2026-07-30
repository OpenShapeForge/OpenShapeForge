// SPDX-License-Identifier: BUSL-1.1
"use client";

import { startTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { bumpGraphqlCacheVersionCookie } from "@/lib/graphql-cache-version";
import { useRealtimeResource } from "@/features/realtime/lib/use-realtime-resource";
import type { RealtimeResourceKey } from "@/features/realtime/lib/resource-keys";

function resolveLang() {
  if (typeof document === "undefined") {
    return "nl";
  }

  return document.documentElement.lang?.toLowerCase().startsWith("en") ? "en" : "nl";
}

function hasDetailAndList(resourceKeys: RealtimeResourceKey[]) {
  return (
    resourceKeys.some((key) => key.startsWith("entity:"))
    && resourceKeys.some((key) => key.startsWith("entity-list:"))
  );
}

function hasListOnly(resourceKeys: RealtimeResourceKey[]) {
  return (
    resourceKeys.some((key) => key.startsWith("entity-list:"))
    && !resourceKeys.some((key) => key.startsWith("entity:"))
  );
}

function resolveRealtimeToastCopy(
  resourceKeys: RealtimeResourceKey[],
  toastLabel?: string,
) {
  const lang = resolveLang();
  const hasDetail = resourceKeys.some((key) => key.startsWith("entity:"));
  const hasList = resourceKeys.some((key) => key.startsWith("entity-list:"));
  const normalizedToastLabel = toastLabel?.trim();

  if (normalizedToastLabel) {
    if (lang === "nl") {
      return {
        title: `${normalizedToastLabel} bijgewerkt`,
        description: hasListOnly(resourceKeys)
          ? "De lijst toont nu de nieuwste wijzigingen."
          : hasDetailAndList(resourceKeys)
            ? "Deze weergave toont nu de nieuwste wijzigingen."
            : "De nieuwste wijzigingen zijn geladen.",
      };
    }

    return {
      title: `${normalizedToastLabel} updated`,
      description: hasListOnly(resourceKeys)
        ? "The list now shows the latest changes."
        : hasDetailAndList(resourceKeys)
          ? "This view now shows the latest changes."
          : "The latest changes have been loaded.",
    };
  }

  if (lang === "nl") {
    if (hasDetail && hasList) {
      return {
        title: "Gegevens bijgewerkt",
        description: "Deze weergave toont nu de nieuwste wijzigingen.",
      };
    }

    if (hasDetail) {
      return {
        title: "Details bijgewerkt",
        description: "De laatste wijzigingen zijn geladen.",
      };
    }

    return {
      title: "Lijst bijgewerkt",
      description: "De laatste wijzigingen zijn geladen.",
    };
  }

  if (hasDetail && hasList) {
    return {
      title: "Data updated",
      description: "This view now shows the latest changes.",
    };
  }

  if (hasDetail) {
    return {
      title: "Details updated",
      description: "The latest changes have been loaded.",
    };
  }

  return {
    title: "List updated",
    description: "The latest changes have been loaded.",
  };
}

export function EntityRealtimeRefresh({
  resourceKeys,
  enabled = true,
  debounceMs = 400,
  toastLabel,
}: {
  resourceKeys: RealtimeResourceKey[];
  enabled?: boolean;
  debounceMs?: number;
  toastLabel?: string;
}) {
  const router = useRouter();

  useRealtimeResource(resourceKeys.length > 0 ? resourceKeys : null, {
    enabled: enabled && resourceKeys.length > 0,
    debounceMs,
    onInvalidate: () => {
      bumpGraphqlCacheVersionCookie();
      const copy = resolveRealtimeToastCopy(resourceKeys, toastLabel);
      toast(copy.title, {
        description: copy.description,
        duration: 2500,
      });

      startTransition(() => {
        router.refresh();
      });
    },
  });

  return null;
}
