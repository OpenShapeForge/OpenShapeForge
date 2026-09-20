// SPDX-License-Identifier: BUSL-1.1
/**
 * Types for entity-action buttons rendered on detail views.
 *
 * These types mirror the `active_entity_actions` read-model in the ERP
 * and the bus-event payloads defined in the entity-actions spec.
 */

import type { Field, VisibilityConfig } from "@/compiler/field-contract";

export interface LocalizedLabel {
  nl?: string;
  en?: string;
}

export interface ActiveAction {
  key: string;
  label: LocalizedLabel;
  description?: LocalizedLabel | null;
  tone: string;
  icon?: string | null;
  visibleWhen?: VisibilityConfig | null;
  disabledWhen?: VisibilityConfig | null;
  disabledMessage?: LocalizedLabel | null;
  /** The one authored field contract; rendered through the renderer's Field. */
  formFields?: Field[] | null;
  awakeableId: string;
  registeredAt?: string;
}

/**
 * Continuation data returned by the trigger endpoint when the next
 * workflow node is a userInput node with its own actions and formFields.
 */
export interface TriggerContinuation {
  actions: ActiveAction[];
}

export interface EntityActionButtonsProps {
  activeActions: ActiveAction[];
  entityState: Record<string, unknown>;
  onActionTriggered?: (key: string) => void;
  presentation?: "buttons" | "relationRows";
}
