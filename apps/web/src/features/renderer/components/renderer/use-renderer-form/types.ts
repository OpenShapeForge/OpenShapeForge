// SPDX-License-Identifier: BUSL-1.1
import type { RendererFormSubmissionResult } from "@/features/renderer/components/renderer/state";
import type { RendererFormDefinition } from "@/features/renderer/form-definition";

export type RendererFieldState = {
  value: unknown;
  touched: boolean;
  error?: string;
};

export type RendererFormUiState = {
  fields: Record<string, RendererFieldState>;
  formError?: string;
  submitAttempted: boolean;
};

export interface UseRendererFormOptions {
  definition: RendererFormDefinition;
  lang: string;
  initialData?: Record<string, unknown> | null;
  action?: (input: Record<string, unknown>) => Promise<{ id?: string } | undefined>;
  id?: string;
  grantedPermissions?: readonly string[];
  validationMode?: "submit" | "eager";
  externalFieldErrors?: Record<string, string | undefined>;
  onSubmit?:
    | ((
        values: Record<string, unknown>,
      ) =>
        | void
        | RendererFormSubmissionResult
        | Promise<void | RendererFormSubmissionResult>)
    | undefined;
}
