// SPDX-License-Identifier: BUSL-1.1
import type { LucideIcon } from "lucide-react";
import type { Field } from "@/generated/compiler/field-contract";

export type WorkflowNodeHandle = {
  id: string;
  label: string;
};

export type WorkflowNodeOutputHandle = WorkflowNodeHandle;

export type WorkflowNodeCategoryAvailability = "process" | "case" | "any";

export type WorkflowNodeDefinition = {
  type: string;
  category: string;
  label: string;
  description: string;
  icon: LucideIcon;
  configFields: Field[];
  defaultConfig: Record<string, unknown>;
  availability?: WorkflowNodeCategoryAvailability;
  normalizeConfig?: (config: Record<string, unknown>) => Record<string, unknown>;
  getOutputHandles?: (config: Record<string, unknown>) => WorkflowNodeHandle[];
  getOutputFields?: (
    config: Record<string, unknown>,
    handleId?: string,
  ) => Field[];
  validate?: (config: Record<string, unknown>) => string[];
};
