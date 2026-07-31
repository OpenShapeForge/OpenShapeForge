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

/**
 * Form field definition as stored on a userInput action.
 * Mirrors the FormFieldDefinition from the workflow service.
 */
export interface ActionFormField {
  key: string;
  valueType: Field["valueType"];
  cardinality?: Field["cardinality"];
  semanticType?: string;
  label: LocalizedLabel;
  required?: boolean;
  description?: LocalizedLabel | null;
  options?: Field["options"];
  render?: Field["render"];
  validation?: Field["validation"];
  children?: Field[];
  item?: Field;
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
  formFields?: ActionFormField[] | null;
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
