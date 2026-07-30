// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@openshapeforge/ui";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@openshapeforge/ui";
import { resolveLucideIconByName } from "@/components/ui/icons/LucideIconByName";
import { evaluateVisibility } from "../lib/evaluate-visibility";
import { triggerEntityAction } from "../lib/trigger-entity-action";
import { EntityActionRow } from "./EntityActionRow";
import { UserInputModal } from "./UserInputModal";
import type { EntityActionButtonsProps, ActiveAction, LocalizedLabel, TriggerContinuation } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pick the best available label — prefer nl, fall back to en, then key. */
function resolveLabel(label: LocalizedLabel | undefined | null, fallback: string): string {
  if (!label) return fallback;
  return label.nl ?? label.en ?? fallback;
}

/** Map the entity-action `tone` to a Button `variant`. */
function toneToVariant(tone: string): "primary" | "outline" | "destructive" {
  switch (tone) {
    case "primary":
      return "primary";
    case "destructive":
      return "destructive";
    default:
      return "outline";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Whether the action has form fields (i.e. it's a userInput action). */
function hasFormFields(action: ActiveAction): boolean {
  return Array.isArray(action.formFields) && action.formFields.length > 0;
}

// ---------------------------------------------------------------------------
// Sub-component: single action button
// ---------------------------------------------------------------------------

function ActionButton({
  action,
  entityState,
  onTriggered,
  presentation,
}: {
  action: ActiveAction;
  entityState: Record<string, unknown>;
  onTriggered?: (key: string) => void;
  presentation: "buttons" | "relationRows";
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [continuationActions, setContinuationActions] = useState<ActiveAction[] | null>(null);

  const isDisabled = evaluateVisibility(action.disabledWhen, entityState) ?? false;
  const disabledMessage = isDisabled ? resolveLabel(action.disabledMessage, "") : null;

  const Icon = resolveLucideIconByName(action.icon ?? undefined);
  const variant = toneToVariant(action.tone);
  const label = resolveLabel(action.label, action.key);

  const handleClick = useCallback(() => {
    // If the action has formFields, open the modal instead of triggering directly
    if (hasFormFields(action)) {
      setModalOpen(true);
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await triggerEntityAction(action.awakeableId);
      if (result.ok) {
        if (result.continuation?.actions?.length) {
          // Next workflow node is a userInput — show its actions in a modal
          setContinuationActions(result.continuation.actions);
        } else {
          onTriggered?.(action.key);
          // Allow time for the workflow to deregister actions via the bus
          // before refetching. The realtime SSE invalidation may also
          // trigger a refresh, but this ensures a timely update.
          setTimeout(() => router.refresh(), 1000);
        }
      } else {
        setError(result.error ?? "trigger_failed");
      }
    });
  }, [action, onTriggered, router]);

  const button = presentation === "relationRows" ? (
    <EntityActionRow
      disabled={isDisabled || isPending}
      icon={Icon}
      label={label}
      onClick={handleClick}
    />
  ) : (
    <Button
      variant={variant}
      size="sm"
      disabled={isDisabled || isPending}
      onClick={handleClick}
      aria-label={label}
    >
      {Icon && <Icon className="size-4" />}
      {label}
    </Button>
  );

  // Wrap in tooltip if there is a disabled message or an error
  const tooltipMessage = error
    ? errorMessage(error)
    : disabledMessage || null;

  const renderedButton = tooltipMessage ? (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* span wrapper needed for tooltip on disabled buttons */}
        <span tabIndex={0} className={presentation === "relationRows" ? "block w-full" : "inline-flex"}>
          {button}
        </span>
      </TooltipTrigger>
      <TooltipContent>{tooltipMessage}</TooltipContent>
    </Tooltip>
  ) : (
    button
  );

  return (
    <>
      {renderedButton}
      {hasFormFields(action) && (
        <UserInputModal
          action={action}
          open={modalOpen}
          onOpenChange={setModalOpen}
          onTriggered={onTriggered}
        />
      )}
      {continuationActions && (
        <UserInputModal
          continuationActions={continuationActions}
          open={!!continuationActions}
          onOpenChange={(open) => { if (!open) setContinuationActions(null); }}
          onTriggered={(key) => {
            setContinuationActions(null);
            onTriggered?.(key);
            setTimeout(() => router.refresh(), 1000);
          }}
        />
      )}
    </>
  );
}

function errorMessage(error: string): string {
  switch (error) {
    case "already_triggered":
      return "Deze actie is al uitgevoerd.";
    case "not_found":
      return "Deze actie is niet meer beschikbaar.";
    default:
      return "Er ging iets mis. Probeer het opnieuw.";
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Renders entity-action buttons for a detail view.
 *
 * - Evaluates `visibleWhen` per action to decide which buttons to show
 * - Evaluates `disabledWhen` per action + shows tooltip with `disabledMessage`
 * - Maps `tone` to the correct button variant (primary = blue, destructive = red)
 * - On click: triggers the workflow awakeable via the trigger API
 */
export function EntityActionButtons({
  activeActions,
  entityState,
  onActionTriggered,
  presentation = "buttons",
}: EntityActionButtonsProps) {
  // Filter to only visible actions
  const visibleActions = activeActions.filter((action) =>
    evaluateVisibility(action.visibleWhen, entityState) ?? true,
  );

  if (visibleActions.length === 0) return null;

  return (
    <TooltipProvider>
      <div className={presentation === "relationRows" ? "flex w-full flex-col" : "flex flex-wrap items-center gap-2"}>
        {visibleActions.map((action) => (
          <ActionButton
            key={action.awakeableId}
            action={action}
            entityState={entityState}
            onTriggered={onActionTriggered}
            presentation={presentation}
          />
        ))}
      </div>
    </TooltipProvider>
  );
}
