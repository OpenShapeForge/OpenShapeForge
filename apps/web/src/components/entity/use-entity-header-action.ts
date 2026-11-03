// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteEntity } from "./entity-delete-client";
import { acceptanceMessage } from "@/lib/operation-acceptance";
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

function defaultDeleteConfirmation(lang: EntityPageHeaderActionsContext["lang"] | undefined) {
  return lang === "nl"
    ? "Dit verwijdert het record permanent. Deze actie kan niet ongedaan worden gemaakt. Doorgaan?"
    : "This permanently deletes the record. This action cannot be undone. Continue?";
}

export function useEntityHeaderAction(
  actionsContext: EntityPageHeaderActionsContext | undefined,
) {
  const router = useRouter();
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
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
      !actionsContext.deleteMutationName ||
      !actionsContext.expectedVersion
    ) {
      setActionError(unavailableDeleteMessage(actionsContext?.lang));
      return;
    }

    const { baseRoute, deleteMutationName, entityId, expectedVersion } = actionsContext;
    if (!window.confirm(action.confirm ?? defaultDeleteConfirmation(actionsContext.lang))) return;

    startTransition(async () => {
      try {
        const outcome = await deleteEntity({
          mutationName: deleteMutationName,
          entityId,
          expectedVersion,
          confirmed: true,
        });
        if ("accepted" in outcome) {
          // Taken over: stay on the record, which still exists, and say so.
          setActionError(null);
          setActionNotice(acceptanceMessage(outcome.accepted, actionsContext.lang));
          router.refresh();
          return;
        }
        router.push(baseRoute);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "Delete failed.");
      }
    });
  }

  return {
    actionError,
    actionNotice,
    handleAction,
    isPending,
  };
}
