// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteEntity } from "./entity-delete-client";
import type {
  EntityPageHeaderAction,
  EntityPageHeaderActionsContext,
} from "./entity-page-contract";

function unavailableDeleteMessage(
  lang: EntityPageHeaderActionsContext["lang"] | undefined,
) {
  return lang === "nl"
    ? "Verwijderen is nog niet beschikbaar in de web-client."
    : "Delete is not available in the web client yet.";
}

export function useEntityHeaderAction(
  actionsContext: EntityPageHeaderActionsContext | undefined,
) {
  const router = useRouter();
  const [actionError, setActionError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleAction(action: EntityPageHeaderAction) {
    if (action.href) {
      router.push(action.href);
      return;
    }

    if (action.route) {
      if (!actionsContext?.baseRoute || !actionsContext.entityId) return;
      router.push(`${actionsContext.baseRoute}/${actionsContext.entityId}/${action.route}`);
      return;
    }

    if (action.mutation !== "delete") return;

    if (
      !actionsContext?.baseRoute ||
      !actionsContext.entityId ||
      !actionsContext.deleteMutationName
    ) {
      setActionError(unavailableDeleteMessage(actionsContext?.lang));
      return;
    }

    const { baseRoute, deleteMutationName, entityId } = actionsContext;
    if (action.confirm && !window.confirm(action.confirm)) return;

    startTransition(async () => {
      try {
        await deleteEntity({
          mutationName: deleteMutationName,
          entityId,
        });
        router.push(baseRoute);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "Delete failed.");
      }
    });
  }

  return {
    actionError,
    handleAction,
    isPending,
  };
}
