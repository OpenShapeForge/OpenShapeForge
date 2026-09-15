// SPDX-License-Identifier: BUSL-1.1
import { operationFailure } from "@openshapeforge/operations";
import type { ModuleOperationHandler } from "@openshapeforge/plugin-runtime";
import { contextServices } from "./commands.js";
import { TemplateContentError } from "./content/errors.js";
import { renderTemplateSnapshot } from "./content/render.js";

export const renderSnapshot: ModuleOperationHandler = async (input, context) => {
  const { session } = contextServices(context);
  if (!session.tenantId) throw operationFailure({ code: "UNAUTHENTICATED", message: "Snapshot rendering requires a tenant session.", retryable: false });
  try {
    return { value: await renderTemplateSnapshot(input.snapshot, { tenantId: session.tenantId }) };
  } catch (error) {
    if (error instanceof TemplateContentError) throw operationFailure({ code: error.code, message: error.message, retryable: false });
    throw error;
  }
};
