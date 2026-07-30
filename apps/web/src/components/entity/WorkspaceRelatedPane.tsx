// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { persistTaskOutput as persistTaskOutputAction } from "@/components/entity/persist-task-output";
import { BodyHeader } from "@/components/ui/layout/body-header";
import {
  detailPaneToRendererDefinition,
  translateDetailText,
} from "@/components/entity/entity-detail-contract";
import type { DetailFieldConfig, DetailGroup } from "@/components/entity/entity-detail-contract";
import { Renderer } from "@/features/renderer/components/renderer";
import type { RendererFormDefinition } from "@/features/renderer/form-definition";
import { FormDefinitionDisplay } from "@/features/renderer/display/form-definition-display";

type RelatedPaneConfig = {
  title?: { en: string; nl: string };
  groups: DetailGroup[];
  fields?: DetailFieldConfig[];
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  weight?: number;
  resizable?: boolean;
};

type WorkspaceRelatedPaneProps = {
  entity: Record<string, unknown>;
  lang: string;
  config: RelatedPaneConfig;
  /** When true, persist embedded human-task form values to task.output via updateTask. */
  persistTaskOutput?: boolean;
};

export function WorkspaceRelatedPane({
  entity,
  lang,
  config,
  persistTaskOutput = false,
}: WorkspaceRelatedPaneProps) {
  const router = useRouter();

  const persistOutput = useCallback(
    async (values: Record<string, unknown>) => {
      const id = typeof entity.id === "string" ? entity.id : undefined;
      if (!id) {
        return;
      }
      await persistTaskOutputAction(id, values);
      router.refresh();
    },
    [entity.id, router],
  );

  const definition: RendererFormDefinition = detailPaneToRendererDefinition(
    {
      ...config,
      fields: (config.fields ?? []).map((field) =>
        field.key === "formDefinition" ? { ...field, hideLabel: true } : field,
      ),
    },
    {
      groupInterpretation: ["none"],
      chrome: {
        showTitle: false,
        showDescription: false,
        showGroupTitles: true,
        showGroupDescriptions: false,
        showActionBar: false,
      },
    },
  );

  return (
    <div className="space-y-4">
      {config.title ? (
        <BodyHeader
          title={translateDetailText(config.title, lang)}
          showBackButton={false}
          className="space-y-0"
        />
      ) : null}
      <Renderer
        definition={definition}
        lang={lang}
        showTitle={false}
        showDescription={false}
        initialData={entity}
        renderCustomField={
          persistTaskOutput
            ? (props) => {
                if (props.field.key !== "formDefinition") {
                  return undefined;
                }
                if (props.component !== "FormDefinitionDisplay") {
                  return undefined;
                }
                return (
                  <FormDefinitionDisplay
                    value={props.value}
                    lang={lang}
                    initialOutput={
                      (entity.output && typeof entity.output === "object"
                        ? (entity.output as Record<string, unknown>)
                        : null) ?? undefined
                    }
                    taskId={typeof entity.id === "string" ? entity.id : undefined}
                    onPersistOutput={persistOutput}
                  />
                );
              }
            : undefined
        }
      />
    </div>
  );
}
