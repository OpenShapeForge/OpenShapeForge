// SPDX-License-Identifier: BUSL-1.1
import type { FieldRenderContext } from "@/features/renderer/components/renderer/field-renderers";
import type { FormGroupInterpretation } from "@/features/renderer/form-definition";

export interface GroupRenderContext extends FieldRenderContext {
  definition: {
    presentation?: {
      groupInterpretation?: readonly FormGroupInterpretation[];
      layout?: {
        columns?: 1 | 2 | 3 | 4;
      };
      chrome?: {
        showGroupTitles?: boolean;
        showGroupDescriptions?: boolean;
      };
    };
    metadata?: Record<string, unknown>;
  };
  showGroupTitles: boolean;
  showGroupDescriptions: boolean;
}
