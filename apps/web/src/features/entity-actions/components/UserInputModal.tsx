// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/overlay/dialog";
import { Button } from "@openshapeforge/ui";
import { Renderer } from "@/features/renderer/components/renderer";
import type { RendererFormDefinition } from "@/features/renderer/form-definition";
import type { Field } from "@/generated/compiler/field-contract";
import { triggerEntityAction } from "../lib/trigger-entity-action";
import type { ActiveAction, ActionFormField, LocalizedLabel } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pick the best available label -- prefer nl, fall back to en, then key. */
function resolveLabel(label: LocalizedLabel | undefined | null, fallback: string): string {
  if (!label) return fallback;
  return label.nl ?? label.en ?? fallback;
}

/**
 * Map the simplified ActionFormField to the canonical compiler Field type
 * that the Renderer understands.
 */
function mapToRendererField(formField: ActionFormField): Field {
  const valueType = normalizeFieldValueType(formField.valueType);
  return {
    ...formField,
    key: formField.key,
    valueType,
    cardinality: formField.cardinality ?? "single",
    required: formField.required ?? false,
    label: formField.label as { nl?: string; en?: string },
    description: formField.description as { nl?: string; en?: string } | undefined,
    render: formField.render ?? getDefaultRender(valueType),
  };
}

function normalizeFieldValueType(
  valueType: unknown,
): Field["valueType"] {
  switch (valueType) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "integer":
      return "integer";
    case "boolean":
      return "boolean";
    case "date":
      return "date";
    case "datetime":
      return "datetime";
    case "object":
      return "object";
    default:
      return "string";
  }
}

function getDefaultRender(valueType: Field["valueType"]): { component: string } | undefined {
  switch (valueType) {
    case "string":
      return { component: "Input" };
    case "number":
    case "integer":
      return { component: "NumberInput" };
    case "boolean":
      return { component: "Checkbox" };
    case "date":
      return { component: "DatePicker" };
    case "datetime":
      return { component: "DatePicker" };
    default:
      return undefined;
  }
}

/**
 * Build a RendererFormDefinition from the action's formFields.
 */
function buildFormDefinition(
  action: ActiveAction,
  formFields: ActionFormField[],
): RendererFormDefinition {
  const fields: Field[] = formFields.map(mapToRendererField);

  return {
    id: `user-input-${action.awakeableId}`,
    mode: "create",
    presentation: {
      surface: "dialog",
      density: "compact",
      chrome: {
        showTitle: false,
        showDescription: false,
        showGroupTitles: false,
        showActionBar: false,
      },
    },
    fields,
    groups: [
      {
        id: "main",
        fields: fields.map((f) => f.key),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface UserInputModalProps {
  /** Direct mode: a single action with formFields. */
  action?: ActiveAction;
  /** Continuation mode: multiple actions from a workflow userInput node. */
  continuationActions?: ActiveAction[];

  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTriggered?: (key: string) => void;
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

/** Whether the action has form fields. */
function hasFormFields(a: ActiveAction): boolean {
  return Array.isArray(a.formFields) && a.formFields.length > 0;
}

export function UserInputModal({
  action,
  continuationActions,
  open,
  onOpenChange,
  onTriggered,
}: UserInputModalProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  // Chained continuations: when a trigger returns another userInput continuation
  const [chainedActions, setChainedActions] = useState<ActiveAction[] | null>(null);

  // Derive the current list of actions from whichever source is active.
  const actions = chainedActions ?? continuationActions ?? (action ? [action] : []);

  // The primary action determines the dialog header and form fields.
  const primaryAction = actions.find((a) => hasFormFields(a)) ?? actions[0];
  const formFields = primaryAction?.formFields ?? [];
  const label = primaryAction ? resolveLabel(primaryAction.label, primaryAction.key) : "";
  const description = primaryAction ? resolveLabel(primaryAction.description, "") : "";
  const formDefinition = useMemo(
    () =>
      primaryAction && formFields.length > 0
        ? buildFormDefinition(primaryAction, formFields)
        : null,
    [formFields, primaryAction],
  );

  // In direct mode (single action prop), show cancel + single submit button.
  const isDirectMode = !continuationActions && !chainedActions && action;

  const handleSubmitAction = useCallback(
    (targetAction: ActiveAction) => {
      setError(null);
      startTransition(async () => {
        const result = await triggerEntityAction(
          targetAction.awakeableId,
          hasFormFields(targetAction) ? formValues : undefined,
        );
        if (result.ok) {
          if (result.continuation?.actions?.length) {
            // Another userInput continuation — update the modal with next step
            setChainedActions(result.continuation.actions);
            setFormValues({});
          } else {
            // No more continuations — close modal
            setChainedActions(null);
            onOpenChange(false);
            onTriggered?.(targetAction.key);
          }
        } else {
          setError(
            result.error === "already_triggered"
              ? "Deze actie is al uitgevoerd."
              : result.error === "not_found"
                ? "Deze actie is niet meer beschikbaar."
                : "Er ging iets mis. Probeer het opnieuw.",
          );
        }
      });
    },
    [formValues, onOpenChange, onTriggered],
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        setChainedActions(null);
        setFormValues({});
        setError(null);
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        {formDefinition && (
          <div className="space-y-4 py-2">
            <Renderer
              definition={formDefinition}
              initialData={formValues}
              onChange={setFormValues}
              showTitle={false}
              showDescription={false}
              fieldDirection="vertical"
            />
          </div>
        )}

        {error && (
          <p className="text-destructive text-sm">{error}</p>
        )}

        <DialogFooter>
          {isDirectMode ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleOpenChange(false)}
                disabled={isPending}
              >
                Annuleren
              </Button>
              <Button
                variant={action.tone === "destructive" ? "destructive" : "primary"}
                size="sm"
                onClick={() => handleSubmitAction(action)}
                disabled={isPending}
              >
                {isPending ? "Bezig..." : label}
              </Button>
            </>
          ) : (
            actions.map((a) => (
              <Button
                key={a.awakeableId}
                variant={toneToVariant(a.tone)}
                size="sm"
                onClick={() => handleSubmitAction(a)}
                disabled={isPending}
              >
                {isPending ? "Bezig..." : resolveLabel(a.label, a.key)}
              </Button>
            ))
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
