// @ts-nocheck
import type { Field } from "../../../../../packages/compiler/src/authoring/types.js";

export type WorkflowAction = "create" | "getOne" | "list" | "update" | "delete" | "wait" | "awaitAction";

export type WorkflowActionConfig =
  | boolean
  | {
      enabled?: boolean;
      readableFields?: string[];
      writableFields?: string[];
      defaultSort?: {
        field: string;
        direction: "asc" | "desc";
      };
    };

export type WorkflowActionEntry = {
  action: WorkflowAction;
  config: Exclude<WorkflowActionConfig, boolean>;
};

export const ACTION_ORDER: Exclude<WorkflowAction, "wait" | "awaitAction">[] = [
  "create",
  "getOne",
  "list",
  "update",
  "delete",
];

export const ACTION_FILE_NAMES: Record<WorkflowAction, string> = {
  create: "create",
  getOne: "get-one",
  list: "list",
  update: "update",
  delete: "delete",
  wait: "wait",
  awaitAction: "await-action",
};

export const ACTION_ICON_NAMES: Record<WorkflowAction, string> = {
  create: "PlusCircle",
  getOne: "Search",
  list: "List",
  update: "Pencil",
  delete: "Trash2",
  wait: "Clock3",
  awaitAction: "ListTodo",
};

export const UNBOUNDED_CARDINALITY = { min: 0, max: "unbounded" as const };

// The only consumer is buildWorkflowBridgeIndexJson, which emits the API
// bridge routing index. Entity nodes expose no error handles (see
// shared/error-routes.ts), so no error-route/field/graphql payload is carried.
export type RuntimeRegistryEntry = {
  type: string;
  module: string;
  entity: string;
  entityKey: string;
  action: WorkflowAction;
};

export type DesignerLazyRegistryEntry = {
  type: string;
  action: WorkflowAction;
  label: string;
  description: string;
  category: string;
  defaultConfig: Record<string, unknown>;
};

export type DesignerDetailRegistryEntry = {
  type: string;
  action: WorkflowAction;
  configFields: Field[];
  defaultOutputFields: Field[];
};

export type RendererEntityFieldSuggestionEntry = {
  entity: string;
  fields: Field[];
};

export type WorkflowEntityGenerationOptions = {
  excludeEntitySlugs?: ReadonlySet<string>;
};
